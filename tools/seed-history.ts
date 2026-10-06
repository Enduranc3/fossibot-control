// Synthetic history for development and the UI check: hourly rows for older days, 10-second rows for
// recent ones, 1-second rows for the last 6 hours, with blackouts, energy and journal events.
// usage: node tools/seed-history.ts <dataDir> [days]
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { SAMPLE_COLUMNS, openDb, type Db } from '../hub/src/db.ts';
import { insertEvent } from '../hub/src/events-store.ts';
import { rollupHours } from '../hub/src/rollup.ts';
import type { HubEvent } from '../shared/events.ts';

export interface SeedOptions {
  nowSec: number;
  days: number;
  /** The most recent days get 10-second rows, older ones hourly rows (default 14). */
  detailDays?: number;
  seed?: number;
}

export interface SeedResult {
  rows1h: number;
  rows10s: number;
  rows1s: number;
  outages: number;
  events: number;
}

const CAPACITY_WH = 2048;
const CHARGE_W = 300;
const round1 = (v: number) => Math.round(v * 10) / 10;

/** Small deterministic PRNG (mulberry32), so every run draws the same history. */
export function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/** Most days have one or two blackouts of 0.5–6 h; windows never overlap and all end over an hour before `to`. */
export function outageWindows(from: number, to: number, rand: () => number): [number, number][] {
  const out: [number, number][] = [];
  let cursor = from;
  for (let day = from; day < to; day += 86_400) {
    const n = rand() < 0.35 ? 0 : rand() < 0.7 ? 1 : 2;
    for (let k = 0; k < n; k++) {
      const start = Math.max(cursor, day + Math.floor(rand() * 86_400));
      const end = start + 1800 + Math.floor(rand() * 5.5 * 3600);
      if (end >= to - 3600) continue;
      out.push([start, end]);
      cursor = end + 3600;
    }
  }
  return out;
}

function hourOfDay(t: number): number {
  const d = new Date(t * 1000);
  return d.getHours() + d.getMinutes() / 60;
}

function loadW(t: number, rand: () => number): number {
  const hour = hourOfDay(t);
  const evening = hour >= 18 && hour < 23 ? 140 : 0;
  return Math.round(80 + 50 * Math.max(0, Math.sin(((hour - 6) / 24) * 2 * Math.PI)) + evening + rand() * 40);
}

function solarW(t: number): number {
  const hour = hourOfDay(t);
  return hour > 7 && hour < 19 ? Math.round(220 * Math.sin((Math.PI * (hour - 7)) / 12)) : 0;
}

export function seedHistory(db: Db, o: SeedOptions): SeedResult {
  const rand = prng(o.seed ?? 1);
  const end = Math.floor(o.nowSec / 10) * 10;
  const start = Math.floor((end - o.days * 86_400) / 3600) * 3600;
  const detailStart = Math.max(start, Math.floor((end - (o.detailDays ?? 14) * 86_400) / 3600) * 3600);
  const windows = outageWindows(start, end, rand);
  const boundaries = windows.flat();
  const cols = SAMPLE_COLUMNS.join(', ');
  const marks = SAMPLE_COLUMNS.map(() => '?').join(', ');
  const insert = (table: string) => db.prepare(`INSERT OR REPLACE INTO ${table} (${cols}) VALUES (${marks})`);
  const ins1h = insert('samples_1h');
  const ins10 = insert('samples_10s');
  const ins1 = insert('samples_1s');
  const energy = new Map<number, { grid: number; solar: number; out: number }>();
  const socAt = new Map<number, number>(); // window boundary → state of charge seen there
  const result: SeedResult = { rows1h: 0, rows10s: 0, rows1s: 0, outages: windows.length, events: 0 };
  let soc = 80;
  let wi = 0; // first window that has not ended yet
  let bi = 0; // next window boundary to stamp with the state of charge

  db.exec('BEGIN');
  try {
    for (let t = start; t < end; ) {
      const dt = t < detailStart ? 3600 : 10;
      while (wi < windows.length && windows[wi][1] <= t) wi++;
      const outage = wi < windows.length && windows[wi][0] <= t;
      while (bi < boundaries.length && boundaries[bi] <= t) socAt.set(boundaries[bi++], Math.round(soc));
      const out = loadW(t, rand);
      const sun = solarW(t);
      let acIn = 0;
      let solar = sun;
      if (outage) {
        soc += ((sun - out) * dt) / 36 / CAPACITY_WH; // W·s → % of capacity
      } else if (soc < 100) {
        acIn = Math.max(0, out + CHARGE_W - sun);
        soc += ((acIn + sun - out) * dt) / 36 / CAPACITY_WH;
      } else {
        solar = Math.min(sun, out);
        acIn = out - solar;
      }
      soc = Math.min(100, Math.max(5, soc));
      const row = [t, Math.round(soc), acIn + solar, out, acIn, out, solar, 0, 0, 2300, 28];
      if (dt === 3600) {
        ins1h.run(...row);
        result.rows1h++;
      } else {
        ins10.run(...row);
        result.rows10s++;
        if (t >= end - 6 * 3600) {
          for (let k = 0; k < 10; k++) ins1.run(t + k, ...row.slice(1));
          result.rows1s += 10;
        }
      }
      const hour = Math.floor(t / 3600) * 3600;
      const e = energy.get(hour) ?? { grid: 0, solar: 0, out: 0 };
      e.grid += (acIn * dt) / 3600;
      e.solar += (solar * dt) / 3600;
      e.out += (out * dt) / 3600;
      energy.set(hour, e);
      t += dt;
    }

    const insEnergy = db.prepare(
      'INSERT OR REPLACE INTO energy_hourly (hour_ts, grid_in_wh, solar_in_wh, out_wh, ac_out_wh) VALUES (?, ?, ?, ?, ?)',
    );
    for (const [hour, e] of energy) insEnergy.run(hour, round1(e.grid), round1(e.solar), round1(e.out), round1(e.out));

    const insOutage = db.prepare('INSERT INTO outages (start_ts, end_ts, soc_start, soc_end, out_wh) VALUES (?, ?, ?, ?, ?)');
    const events: HubEvent[] = [];
    for (const [a, b] of windows) {
      const socStart = socAt.get(a) ?? null;
      const socEnd = socAt.get(b) ?? null;
      insOutage.run(a, b, socStart, socEnd, Math.round(((b - a) / 3600) * 160));
      events.push(
        { ts: a, type: 'grid_lost', source: 'hub', data: { soc: socStart } },
        { ts: b, type: 'grid_restored', source: 'hub', data: { soc: socEnd } },
      );
    }
    const evening = new Date(start * 1000);
    evening.setHours(19, 0, 0, 0);
    for (let i = 0; evening.getTime() / 1000 < end - 3600; i++, evening.setDate(evening.getDate() + 1)) {
      const ts = evening.getTime() / 1000;
      events.push({ ts, type: 'output_changed', source: 'app', data: { output: 'led', from: 0, to: 1 } });
      events.push({ ts: ts + 1800, type: 'output_changed', source: 'station', data: { output: 'led', from: 1, to: 0 } });
      if (i % 7 === 3) events.push({ ts: ts + 600, type: 'setting_changed', source: 'app', data: { register: 'chargeLimit', from: 100, to: 90 } });
    }
    const t3 = end - 3 * 86_400;
    events.push(
      { ts: t3, type: 'fault_set', source: 'station', data: { kind: 'pv', code: 4 } },
      { ts: t3 + 900, type: 'fault_cleared', source: 'station', data: { kind: 'pv', code: 4 } },
    );
    const t2 = end - 2 * 86_400 + 7200;
    events.push({ ts: t2, type: 'link_lost', source: 'hub', data: {} }, { ts: t2 + 240, type: 'link_restored', source: 'hub', data: {} });
    events.push({ ts: end - 86_400 + 3 * 3600, type: 'soc_low', source: 'hub', data: { soc: 19, threshold: 20 } });
    events.sort((p, q) => p.ts - q.ts);
    for (const e of events) insertEvent(db, e);
    result.events = events.length;
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  rollupHours(db, o.nowSec);
  return result;
}

if (import.meta.main) {
  const { positionals } = parseArgs({ allowPositionals: true });
  const [dir, days = '400'] = positionals;
  if (!dir) {
    console.error('usage: node tools/seed-history.ts <dataDir> [days]');
    process.exit(1);
  }
  mkdirSync(dir, { recursive: true });
  const db = openDb(join(dir, 'hub.db'));
  const r = seedHistory(db, { nowSec: Math.floor(Date.now() / 1000), days: Number(days) });
  db.close();
  console.log(`[seed] ${JSON.stringify(r)}`);
}
