import { describe, expect, it } from 'vitest';
import { openDb, type Db } from './db.ts';
import { Recorder, type EnergyDelta } from './recorder.ts';
import { makeSnapshot } from './test-helpers.ts';

const T0 = 1_759_700_000; // unix seconds, aligned to a 10 s bucket
const count = (db: Db, table: string) => (db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;
const energy = (db: Db) =>
  db.prepare('SELECT * FROM energy_hourly ORDER BY hour_ts').all() as {
    hour_ts: number;
    grid_in_wh: number;
    out_wh: number;
  }[];

function feed(rec: Recorder, fromSec: number, seconds: number, o: Parameters<typeof makeSnapshot>[1] = {}) {
  for (let i = 0; i < seconds; i++) rec.onSnapshot(makeSnapshot((fromSec + i) * 1000, o));
}

describe('Recorder', () => {
  it('integrates power into hourly energy', () => {
    const db = openDb(':memory:');
    const rec = new Recorder(db);
    feed(rec, 0, 3601, { acInW: 100, outW: 50 });
    rec.flush();
    const rows = energy(db);
    expect(rows).toHaveLength(1);
    expect(rows[0].hour_ts).toBe(0);
    expect(rows[0].grid_in_wh).toBeCloseTo(100, 1);
    expect(rows[0].out_wh).toBeCloseTo(50, 1);
  });

  it('does not integrate across gaps, backwards clock jumps or duplicate timestamps', () => {
    const db = openDb(':memory:');
    const rec = new Recorder(db);
    rec.onSnapshot(makeSnapshot(T0 * 1000, { acInW: 1000 }));
    rec.onSnapshot(makeSnapshot((T0 + 60) * 1000, { acInW: 1000 })); // 60 s gap
    rec.onSnapshot(makeSnapshot((T0 - 3600) * 1000, { acInW: 1000 })); // clock went back an hour
    rec.onSnapshot(makeSnapshot((T0 - 3600) * 1000, { acInW: 1000 })); // same timestamp
    rec.flush();
    expect(energy(db)).toHaveLength(0);
  });

  it('writes one 1-second row per second and 10-second averages', () => {
    const db = openDb(':memory:');
    const rec = new Recorder(db);
    for (let i = 0; i < 20; i++) rec.onSnapshot(makeSnapshot((T0 + i) * 1000, { outW: i < 10 ? 100 : 200, soc: 50 + i }));
    rec.onSnapshot(makeSnapshot((T0 + 20) * 1000)); // closes the second bucket
    rec.flush();
    expect(count(db, 'samples_1s')).toBe(21);
    const tens = db.prepare('SELECT ts, out_w, soc FROM samples_10s ORDER BY ts').all();
    expect(tens).toEqual([
      { ts: T0, out_w: 100, soc: 59 },
      { ts: T0 + 10, out_w: 200, soc: 69 },
    ]);
  });

  it('flush is idempotent and keeps buffers when the database fails', () => {
    const db = openDb(':memory:');
    const rec = new Recorder(db);
    feed(rec, T0, 3);
    db.exec('ALTER TABLE samples_1s RENAME TO broken');
    expect(() => rec.flush()).toThrow();
    db.exec('ALTER TABLE broken RENAME TO samples_1s');
    rec.flush();
    rec.flush();
    expect(count(db, 'samples_1s')).toBe(3);
  });

  it('notifies energy listeners with every delta', () => {
    const db = openDb(':memory:');
    const rec = new Recorder(db);
    const seen: EnergyDelta[] = [];
    rec.onEnergy((d) => seen.push(d));
    feed(rec, T0, 3, { outW: 3600 });
    expect(seen).toHaveLength(2);
    expect(seen[0].outWh).toBeCloseTo(1, 5);
  });

  it('prunes 1-second samples by retention', () => {
    const db = openDb(':memory:');
    const rec = new Recorder(db, { retentionDays: 1 });
    feed(rec, T0, 5);
    feed(rec, T0 + 3 * 86_400, 5);
    rec.flush();
    expect(rec.prune(T0 + 3 * 86_400)).toBe(5);
    expect(count(db, 'samples_1s')).toBe(5);
    expect(count(db, 'samples_10s')).toBeGreaterThan(0);
  });

  it('prunes the oldest days when the database is over the size limit', () => {
    const db = openDb(':memory:');
    const rec = new Recorder(db, { maxDbBytes: 1 });
    feed(rec, T0, 5);
    feed(rec, T0 + 86_400, 5);
    rec.flush();
    rec.prune(T0 + 86_400 + 10);
    expect(count(db, 'samples_1s')).toBe(0);
  });
});
