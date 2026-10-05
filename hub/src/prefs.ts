import { kvGet, kvSet, type Db } from './db.ts';
import { DEFAULT_CAPACITY_WH } from './forecast.ts';

export const NOTIFY_KINDS = [
  'grid_lost',
  'grid_restored',
  'soc_low',
  'link_lost',
  'fault_set',
  'output_changed',
  'setting_changed',
  'hub_started',
] as const;
export type NotifyKind = (typeof NOTIFY_KINDS)[number];

export interface Prefs {
  socLowThreshold: number;
  capacityWh: number;
  notify: Record<NotifyKind, boolean>;
}

export const DEFAULT_PREFS: Prefs = {
  socLowThreshold: 20,
  capacityWh: DEFAULT_CAPACITY_WH,
  notify: {
    grid_lost: true,
    grid_restored: true,
    soc_low: true,
    link_lost: true,
    fault_set: true,
    output_changed: false,
    setting_changed: false,
    hub_started: false,
  },
};

const isInt = (v: unknown, min: number, max: number) => typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;

export class PrefsStore {
  private readonly db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  get(): Prefs {
    const p = kvGet<Partial<Prefs>>(this.db, 'prefs') ?? {};
    return { ...DEFAULT_PREFS, ...p, notify: { ...DEFAULT_PREFS.notify, ...(p.notify ?? {}) } };
  }

  update(patch: unknown): Prefs {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('Очікується об’єкт налаштувань');
    const p = patch as Record<string, unknown>;
    const next = this.get();
    if ('socLowThreshold' in p) {
      if (!isInt(p.socLowThreshold, 5, 80)) throw new Error('Поріг заряду: 5–80 %');
      next.socLowThreshold = p.socLowThreshold as number;
    }
    if ('capacityWh' in p) {
      if (!isInt(p.capacityWh, 200, 5000)) throw new Error('Ємність: 200–5000 Вт·год');
      next.capacityWh = p.capacityWh as number;
    }
    if ('notify' in p) {
      const n = p.notify as Record<string, unknown>;
      if (!n || typeof n !== 'object') throw new Error('notify має бути об’єктом');
      for (const [k, v] of Object.entries(n)) {
        if (!(NOTIFY_KINDS as readonly string[]).includes(k) || typeof v !== 'boolean') throw new Error(`Невідоме сповіщення: ${k}`);
        next.notify[k as NotifyKind] = v;
      }
    }
    kvSet(this.db, 'prefs', next);
    return next;
  }
}
