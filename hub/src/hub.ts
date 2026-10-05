import { mkdirSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import type { HubEvent } from '../../shared/events.ts';
import { toSnapshot, type Snapshot } from '../../shared/telemetry.ts';
import { createHttpServer } from './api/http.ts';
import { LiveHub } from './api/live.ts';
import { buildRoutes } from './api/routes.ts';
import { Auth } from './auth.ts';
import { CommandQueue } from './command-queue.ts';
import type { HubContext, StateView } from './context.ts';
import { openDb } from './db.ts';
import { EventDetector, type GridRule } from './event-detector.ts';
import { insertEvent } from './events-store.ts';
import { LoadAverager, learnCapacity, runtimeHours } from './forecast.ts';
import { energyTotalsSince, localMidnight } from './history.ts';
import { OutageTracker } from './outages.ts';
import { PrefsStore } from './prefs.ts';
import { Recorder } from './recorder.ts';
import { StationLink } from './station-link.ts';

export interface HubConfig {
  dataDir: string;
  httpHost: string;
  httpPort: number;
  stationHost: string;
  stationPort: number;
  allowedStationPrefix?: string;
  allowedOrigins: string[];
  linkTimeoutMs?: number;
  confirmMs?: number;
  flushIntervalMs?: number;
  gridRule?: GridRule;
  /** Built web app to serve (dist/web); omitted = API only. */
  webDir?: string;
  log?: (m: string) => void;
}

export interface RunningHub {
  httpPort: number;
  stationPort: number;
  ctx: HubContext;
  live: LiveHub;
  stop(): Promise<void>;
}

/** Runs fn and logs instead of throwing, so one failing subsystem never stops the others. */
export function runSafely(name: string, fn: () => void, log: (m: string) => void): boolean {
  try {
    fn();
    return true;
  } catch (err) {
    log(`${name} failed: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

const nowSec = () => Math.floor(Date.now() / 1000);

export async function startHub(cfg: HubConfig): Promise<RunningHub> {
  const log = cfg.log ?? ((m: string) => console.log(`[hub] ${new Date().toISOString()} ${m}`));
  mkdirSync(cfg.dataDir, { recursive: true });
  const db = openDb(join(cfg.dataDir, 'hub.db'));
  const auth = new Auth(db);
  const prefs = new PrefsStore(db);
  const link = new StationLink({
    port: cfg.stationPort,
    host: cfg.stationHost,
    allowedPrefix: cfg.allowedStationPrefix,
    linkTimeoutMs: cfg.linkTimeoutMs,
  });
  const queue = new CommandQueue(link, { confirmMs: cfg.confirmMs });
  const recorder = new Recorder(db);
  const outages = new OutageTracker(db);
  const load = new LoadAverager();
  let latest: Snapshot | null = null;
  let live: LiveHub | null = null;

  // Events that could not be stored (full or locked database) are retried on the next flush.
  const pendingEvents: HubEvent[] = [];
  const emit = (e: HubEvent) => {
    // The outage tracker keeps its state in memory, so it runs even when the database is failing.
    const finished = outages.onEvent(e);
    if (finished) {
      runSafely('capacity', () => prefs.update({ capacityWh: learnCapacity(prefs.get().capacityWh, finished) }), log);
    }
    let id: number | undefined;
    const stored = runSafely(
      'event',
      () => {
        id = insertEvent(db, e);
      },
      log,
    );
    if (!stored) pendingEvents.push(e);
    live?.broadcast({ type: 'event', event: { ...e, id } });
  };

  const detector = new EventDetector({
    wasRequested: (r, v) => queue.wasRequested(r, v),
    socLowThreshold: () => prefs.get().socLowThreshold,
    emit,
    gridRule: cfg.gridRule,
    initialGridPresent: outages.ongoing() ? false : null,
    onGrid: (g) => live?.broadcast({ type: 'grid', ...g }),
  });
  recorder.onEnergy((d) => outages.addEnergy(d));

  link.on('report', (regs, ts) => {
    const s = toSnapshot(regs, ts);
    latest = s;
    recorder.onSnapshot(s);
    detector.onSnapshot(s);
    load.add(Math.floor(ts / 1000), s.outW);
    live?.broadcast({ type: 'telemetry', snapshot: s });
  });
  link.on('state', (st) => {
    log(`station link ${st}`);
    detector.onLinkState(st, nowSec());
    live?.broadcast({ type: 'link', state: st });
  });

  const state = (): StateView => {
    const p = prefs.get();
    const avg = load.average();
    return {
      link: link.state,
      snapshot: latest,
      grid: { ...detector.grid },
      outage: outages.ongoing(),
      forecast: {
        capacityWh: p.capacityWh,
        avgLoadW: avg === null ? null : Math.round(avg),
        runtimeHours: latest ? runtimeHours(latest.soc, latest.dischargeLimit ?? 0, p.capacityWh, avg) : null,
        stationRemainingMin: latest?.stationRemainingMin ?? null,
      },
      today: energyTotalsSince(db, localMidnight(nowSec())),
    };
  };

  const ctx: HubContext = { db, auth, queue, prefs, state };
  const server = createHttpServer({
    routes: buildRoutes(ctx),
    auth,
    allowedOrigins: cfg.allowedOrigins,
    staticDir: cfg.webDir,
    log,
  });
  const liveHub = new LiveHub(server, { auth, allowedOrigins: cfg.allowedOrigins, hello: state });
  live = liveHub;

  await link.start();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(cfg.httpPort, cfg.httpHost, () => resolve());
  });
  emit({ ts: nowSec(), type: 'hub_started', source: 'hub', data: {} });

  const flush = () =>
    runSafely(
      'flush',
      () => {
        recorder.flush();
        outages.persist();
        while (pendingEvents.length) {
          insertEvent(db, pendingEvents[0]);
          pendingEvents.shift();
        }
      },
      log,
    );
  const flushTimer = setInterval(flush, cfg.flushIntervalMs ?? 10_000);
  const pruneTimer = setInterval(() => runSafely('prune', () => recorder.prune(nowSec()), log), 3_600_000);

  return {
    httpPort: (server.address() as AddressInfo).port,
    stationPort: link.port,
    ctx,
    live: liveHub,
    async stop() {
      clearInterval(flushTimer);
      clearInterval(pruneTimer);
      flush();
      liveHub.close();
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
      await link.stop();
      db.close();
    },
  };
}
