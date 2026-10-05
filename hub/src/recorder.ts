import type { Snapshot } from '../../shared/telemetry.ts';
import { SAMPLE_COLUMNS, usedBytes, type Db } from './db.ts';

/** Energy accumulated between two consecutive reports, attributed to the hour it started in. */
export interface EnergyDelta {
  hourTs: number;
  gridInWh: number;
  solarInWh: number;
  outWh: number;
  acOutWh: number;
  dcOutWh: number;
  usbOutWh: number;
}

export interface RecorderOptions {
  retentionDays?: number;
  maxDbBytes?: number;
  maxGapSec?: number;
}

/** Row values in SAMPLE_COLUMNS order. */
type SampleRow = (number | null)[];

const ENERGY_FIELDS = ['gridInWh', 'solarInWh', 'outWh', 'acOutWh', 'dcOutWh', 'usbOutWh'] as const;

function toRow(s: Snapshot, sec: number): SampleRow {
  return [
    sec,
    Math.round(s.soc),
    Math.round(s.inW),
    Math.round(s.outW),
    Math.round(s.acInW),
    Math.round(s.acOutW),
    Math.round(s.solarW),
    Math.round(s.dcW),
    Math.round(s.usbW),
    s.acV === null ? null : Math.round(s.acV * 10),
    s.tempC === null ? null : Math.round(s.tempC),
  ];
}

function average(start: number, rows: SampleRow[]): SampleRow {
  const out: SampleRow = [start, rows[rows.length - 1][1]];
  for (let i = 2; i < SAMPLE_COLUMNS.length; i++) {
    const vals = rows.map((r) => r[i]).filter((v): v is number => v !== null);
    out[i] = vals.length ? Math.round(vals.reduce((a, v) => a + v, 0) / vals.length) : null;
  }
  return out;
}

export class Recorder {
  private readonly db: Db;
  private readonly retentionDays: number;
  private readonly maxDbBytes: number;
  private readonly maxGapSec: number;
  private prev: Snapshot | null = null;
  private readonly pending1s = new Map<number, SampleRow>();
  private pending10s: SampleRow[] = [];
  private bucket: { start: number; rows: SampleRow[] } | null = null;
  private readonly pendingEnergy = new Map<number, EnergyDelta>();
  private readonly listeners: ((d: EnergyDelta) => void)[] = [];

  constructor(db: Db, opts: RecorderOptions = {}) {
    this.db = db;
    this.retentionDays = opts.retentionDays ?? 365;
    this.maxDbBytes = opts.maxDbBytes ?? 8e9;
    this.maxGapSec = opts.maxGapSec ?? 5;
  }

  onEnergy(fn: (d: EnergyDelta) => void): void {
    this.listeners.push(fn);
  }

  onSnapshot(s: Snapshot): void {
    const sec = Math.floor(s.ts / 1000);
    const row = toRow(s, sec);
    this.pending1s.set(sec, row);
    this.addToBucket(sec, row);
    if (this.prev) {
      const dt = (s.ts - this.prev.ts) / 1000;
      if (dt > 0 && dt <= this.maxGapSec) this.integrate(this.prev, dt);
    }
    this.prev = s;
  }

  flush(): void {
    if (!this.pending1s.size && !this.pending10s.length && !this.pendingEnergy.size) return;
    const cols = SAMPLE_COLUMNS.join(', ');
    const marks = SAMPLE_COLUMNS.map(() => '?').join(', ');
    const ins1 = this.db.prepare(`INSERT OR REPLACE INTO samples_1s (${cols}) VALUES (${marks})`);
    const ins10 = this.db.prepare(`INSERT OR REPLACE INTO samples_10s (${cols}) VALUES (${marks})`);
    const upsert = this.db.prepare(
      `INSERT INTO energy_hourly (hour_ts, grid_in_wh, solar_in_wh, out_wh, ac_out_wh, dc_out_wh, usb_out_wh)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(hour_ts) DO UPDATE SET
         grid_in_wh = grid_in_wh + excluded.grid_in_wh, solar_in_wh = solar_in_wh + excluded.solar_in_wh,
         out_wh = out_wh + excluded.out_wh, ac_out_wh = ac_out_wh + excluded.ac_out_wh,
         dc_out_wh = dc_out_wh + excluded.dc_out_wh, usb_out_wh = usb_out_wh + excluded.usb_out_wh`,
    );
    this.db.exec('BEGIN');
    try {
      for (const r of this.pending1s.values()) ins1.run(...r);
      for (const r of this.pending10s) ins10.run(...r);
      for (const e of this.pendingEnergy.values()) {
        upsert.run(e.hourTs, e.gridInWh, e.solarInWh, e.outWh, e.acOutWh, e.dcOutWh, e.usbOutWh);
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    this.pending1s.clear();
    this.pending10s = [];
    this.pendingEnergy.clear();
  }

  /** Deletes 1-second samples past retention, then the oldest days while over the size limit. */
  prune(nowSec: number): number {
    const del = this.db.prepare('DELETE FROM samples_1s WHERE ts < ?');
    let deleted = Number(del.run(nowSec - this.retentionDays * 86_400).changes);
    while (usedBytes(this.db) > this.maxDbBytes) {
      const { t } = this.db.prepare('SELECT min(ts) AS t FROM samples_1s').get() as { t: number | null };
      if (t === null) break;
      deleted += Number(del.run(t + 86_400).changes);
    }
    if (deleted) this.db.exec('PRAGMA incremental_vacuum');
    return deleted;
  }

  private addToBucket(sec: number, row: SampleRow) {
    const start = Math.floor(sec / 10) * 10;
    if (this.bucket && this.bucket.start !== start) {
      this.pending10s.push(average(this.bucket.start, this.bucket.rows));
      this.bucket = null;
    }
    if (!this.bucket) this.bucket = { start, rows: [] };
    this.bucket.rows.push(row);
  }

  private integrate(p: Snapshot, dtSec: number) {
    const h = dtSec / 3600;
    const hourTs = Math.floor(p.ts / 3_600_000) * 3600;
    const d: EnergyDelta = {
      hourTs,
      gridInWh: p.acInW * h,
      solarInWh: p.solarW * h,
      outWh: p.outW * h,
      acOutWh: p.acOutW * h,
      dcOutWh: p.dcW * h,
      usbOutWh: p.usbW * h,
    };
    const acc = this.pendingEnergy.get(hourTs);
    if (acc) for (const f of ENERGY_FIELDS) acc[f] += d[f];
    else this.pendingEnergy.set(hourTs, { ...d });
    for (const fn of this.listeners) fn(d);
  }
}
