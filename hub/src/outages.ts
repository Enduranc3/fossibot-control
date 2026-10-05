import type { HubEvent } from '../../shared/events.ts';
import type { Db } from './db.ts';
import type { EnergyDelta } from './recorder.ts';

export interface Outage {
  id: number;
  startTs: number;
  endTs: number | null;
  socStart: number | null;
  socEnd: number | null;
  outWh: number;
}

export interface OutageRow {
  id: number;
  start_ts: number;
  end_ts: number | null;
  soc_start: number | null;
  soc_end: number | null;
  out_wh: number;
}

export function rowToOutage(r: OutageRow): Outage {
  return { id: r.id, startTs: r.start_ts, endTs: r.end_ts, socStart: r.soc_start, socEnd: r.soc_end, outWh: r.out_wh };
}

const socOf = (e: HubEvent) => (typeof e.data.soc === 'number' ? e.data.soc : null);

export class OutageTracker {
  private readonly db: Db;
  private current: Outage | null;

  constructor(db: Db) {
    this.db = db;
    const row = db.prepare('SELECT * FROM outages WHERE end_ts IS NULL ORDER BY id DESC LIMIT 1').get() as
      | OutageRow
      | undefined;
    this.current = row ? rowToOutage(row) : null;
  }

  ongoing(): Outage | null {
    return this.current ? { ...this.current } : null;
  }

  /** Returns the finished outage on grid_restored, otherwise null. */
  onEvent(e: HubEvent): Outage | null {
    if (e.type === 'grid_lost' && !this.current) {
      const soc = socOf(e);
      const r = this.db.prepare('INSERT INTO outages (start_ts, soc_start) VALUES (?, ?)').run(e.ts, soc);
      this.current = { id: Number(r.lastInsertRowid), startTs: e.ts, endTs: null, socStart: soc, socEnd: null, outWh: 0 };
      return null;
    }
    if (e.type === 'grid_restored' && this.current) {
      const done: Outage = { ...this.current, endTs: e.ts, socEnd: socOf(e) };
      this.db
        .prepare('UPDATE outages SET end_ts = ?, soc_end = ?, out_wh = ? WHERE id = ?')
        .run(done.endTs, done.socEnd, done.outWh, done.id);
      this.current = null;
      return done;
    }
    return null;
  }

  addEnergy(d: EnergyDelta): void {
    if (this.current) this.current.outWh += d.outWh;
  }

  persist(): void {
    if (this.current) this.db.prepare('UPDATE outages SET out_wh = ? WHERE id = ?').run(this.current.outWh, this.current.id);
  }
}
