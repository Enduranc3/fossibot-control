import webpush from 'web-push';
import type { HubEvent } from '../../shared/events.ts';
import { describeEvent } from '../../web/src/events-text.ts';
import { kvGet, kvSet, type Db } from './db.ts';
import type { NotifyKind, Prefs } from './prefs.ts';

export interface PushSubscriptionJson {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

export interface PushPayload {
  title: string;
  body: string;
  tag: string;
  url: string;
}

export interface VapidKeys {
  publicKey: string;
  privateKey: string;
}

export type PushSend = (sub: PushSubscriptionJson, payload: string, keys: VapidKeys) => Promise<void>;

/** VAPID keys are made on first use and kept in kv: a new key would orphan every subscription. */
export function vapidKeys(db: Db): VapidKeys {
  const saved = kvGet<VapidKeys>(db, 'vapid_keys');
  if (saved) return saved;
  const keys = webpush.generateVAPIDKeys();
  kvSet(db, 'vapid_keys', keys);
  return keys;
}

const shortString = (v: unknown, max: number): v is string => typeof v === 'string' && v.length > 0 && v.length <= max;

export function validSubscription(v: unknown): PushSubscriptionJson | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } };
  if (!shortString(o.endpoint, 2048) || !o.endpoint.startsWith('https://')) return null;
  if (!o.keys || !shortString(o.keys.p256dh, 256) || !shortString(o.keys.auth, 256)) return null;
  return { endpoint: o.endpoint, keys: { p256dh: o.keys.p256dh, auth: o.keys.auth } };
}

type Transport = (sub: PushSubscriptionJson, payload: string, options: webpush.RequestOptions) => Promise<unknown>;

export function webPushSender(subject: string, transport: Transport = webpush.sendNotification): PushSend {
  return async (sub, payload, keys) => {
    await transport(sub, payload, {
      vapidDetails: { subject, publicKey: keys.publicKey, privateKey: keys.privateKey },
      TTL: 6 * 3600,
      urgency: 'high',
      // Without mobile internet a request would otherwise wait for the kernel's connect timeout.
      timeout: 15_000,
    });
  };
}

/** Event types that can become notifications; everything else (fault_cleared, link_restored…) never does. */
const KIND_OF: Partial<Record<HubEvent['type'], NotifyKind>> = {
  grid_lost: 'grid_lost',
  grid_restored: 'grid_restored',
  soc_low: 'soc_low',
  link_lost: 'link_lost',
  fault_set: 'fault_set',
  output_changed: 'output_changed',
  setting_changed: 'setting_changed',
  hub_started: 'hub_started',
};

export function payloadFor(e: HubEvent): PushPayload {
  const t = describeEvent(e);
  return { title: t.title, body: t.detail, tag: e.type, url: e.type.startsWith('grid_') ? '/#/outages' : '/#/journal' };
}

export interface PushServiceOptions {
  db: Db;
  prefs: () => Prefs;
  send: PushSend;
  /** Spec §8: a lost station link is news only after it lasted this long. */
  linkLostDelayMs?: number;
  log?: (m: string) => void;
}

interface SubscriptionRow {
  endpoint: string;
  p256dh: string;
  auth: string;
}

export class PushService {
  private readonly db: Db;
  private readonly prefs: () => Prefs;
  private readonly send: PushSend;
  private readonly linkLostDelayMs: number;
  private readonly log: (m: string) => void;
  private linkTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(o: PushServiceOptions) {
    this.db = o.db;
    this.prefs = o.prefs;
    this.send = o.send;
    this.linkLostDelayMs = o.linkLostDelayMs ?? 120_000;
    this.log = o.log ?? (() => {});
  }

  publicKey(): string {
    return vapidKeys(this.db).publicKey;
  }

  subscribe(sub: PushSubscriptionJson): void {
    this.db
      .prepare(
        `INSERT INTO push_subscriptions (endpoint, p256dh, auth, created_ts) VALUES (?, ?, ?, ?)
         ON CONFLICT(endpoint) DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth`,
      )
      .run(sub.endpoint, sub.keys.p256dh, sub.keys.auth, Math.floor(Date.now() / 1000));
  }

  unsubscribe(endpoint: string): boolean {
    return Number(this.db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').run(endpoint).changes) > 0;
  }

  count(): number {
    return (this.db.prepare('SELECT count(*) AS n FROM push_subscriptions').get() as { n: number }).n;
  }

  /** Called for every hub event; never throws (a failing push must not disturb event handling). */
  onEvent(e: HubEvent): void {
    try {
      if (e.type === 'link_restored') return this.cancelLinkTimer();
      const kind = KIND_OF[e.type];
      if (!kind) return;
      if (e.type === 'grid_lost' && e.data.initial === true) return; // the hub started during an outage: not news
      if (e.type === 'link_lost') {
        this.cancelLinkTimer();
        const payload = { ...payloadFor(e), body: 'понад 2 хвилини' };
        this.linkTimer = setTimeout(() => {
          this.linkTimer = null;
          this.notifySafely(kind, payload);
        }, this.linkLostDelayMs);
        this.linkTimer.unref?.();
        return;
      }
      this.notifySafely(kind, payloadFor(e));
    } catch (err) {
      this.log(`push: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async notify(kind: NotifyKind, payload: PushPayload): Promise<number> {
    if (!this.prefs().notify[kind]) return 0;
    return this.broadcast(payload);
  }

  /** Sends to every subscription; drops the ones the push service reports gone (404/410). Returns how many got it. */
  async broadcast(payload: PushPayload): Promise<number> {
    const subs = this.db.prepare('SELECT endpoint, p256dh, auth FROM push_subscriptions').all() as unknown as SubscriptionRow[];
    if (!subs.length) return 0;
    const keys = vapidKeys(this.db);
    const body = JSON.stringify(payload);
    let delivered = 0;
    await Promise.all(
      subs.map(async (s) => {
        try {
          await this.send({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, body, keys);
          delivered++;
        } catch (err) {
          const status = (err as { statusCode?: unknown }).statusCode;
          if (status === 404 || status === 410) this.unsubscribe(s.endpoint);
          else this.log(`push failed: ${String(status ?? (err instanceof Error ? err.message : err))}`);
        }
      }),
    );
    return delivered;
  }

  stop(): void {
    this.cancelLinkTimer();
  }

  private notifySafely(kind: NotifyKind, payload: PushPayload) {
    this.notify(kind, payload).catch((err: unknown) => this.log(`push: ${err instanceof Error ? err.message : String(err)}`));
  }

  private cancelLinkTimer() {
    if (this.linkTimer) clearTimeout(this.linkTimer);
    this.linkTimer = null;
  }
}
