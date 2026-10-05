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

/**
 * Tracks the current outage in memory first and writes it to the database as a best effort, so a
 * full or locked database never loses an outage: persist() retries whatever could not be written.
 */
export class OutageTracker {
  private readonly db: Db;
  private current: Outage | null;
  /** Finished outages whose final write failed; written by persist(). */
  private unsaved: Outage[] = [];

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

  /** Returns the finished outage on grid_restored, otherwise null. Never throws on database errors. */
  onEvent(e: HubEvent): Outage | null {
    if (e.type === 'grid_lost' && !this.current) {
      this.current = { id: 0, startTs: e.ts, endTs: null, socStart: socOf(e), socEnd: null, outWh: 0 };
      this.tryWrite(this.current);
      return null;
    }
    if (e.type === 'grid_restored' && this.current) {
      const done: Outage = { ...this.current, endTs: e.ts, socEnd: socOf(e) };
      this.current = null;
      if (!this.tryWrite(done)) this.unsaved.push(done);
      return { ...done };
    }
    return null;
  }

  addEnergy(d: EnergyDelta): void {
    if (this.current) this.current.outWh += d.outWh;
  }

  /** Writes pending outages and the running one; throws if the database is still unwritable. */
  persist(): void {
    while (this.unsaved.length) {
      this.write(this.unsaved[0]);
      this.unsaved.shift();
    }
    if (this.current) this.write(this.current);
  }

  private tryWrite(o: Outage): boolean {
    try {
      this.write(o);
      return true;
    } catch {
      return false;
    }
  }

  /** Inserts the outage (id 0 = not yet stored, the new id is assigned) or updates it. */
  private write(o: Outage): void {
    if (o.id) {
      this.db
        .prepare('UPDATE outages SET start_ts = ?, end_ts = ?, soc_start = ?, soc_end = ?, out_wh = ? WHERE id = ?')
        .run(o.startTs, o.endTs, o.socStart, o.socEnd, o.outWh, o.id);
      return;
    }
    const r = this.db
      .prepare('INSERT INTO outages (start_ts, end_ts, soc_start, soc_end, out_wh) VALUES (?, ?, ?, ?, ?)')
      .run(o.startTs, o.endTs, o.socStart, o.socEnd, o.outWh);
    o.id = Number(r.lastInsertRowid);
  }
}
