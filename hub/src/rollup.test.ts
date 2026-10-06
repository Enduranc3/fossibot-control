import { describe, expect, it } from 'vitest';
import { SAMPLE_COLUMNS, openDb, type Db } from './db.ts';
import { queryHistory } from './history.ts';
import { rolledUntil, rollupHours } from './rollup.ts';

// Local midnight in Kyiv is also a whole UTC hour, so hours line up with the table.
const OCT1 = Math.floor(new Date(2026, 9, 1).getTime() / 1000);

function seed10s(db: Db, from: number, count: number, inW: (i: number) => number) {
  const ins = db.prepare(`INSERT INTO samples_10s (${SAMPLE_COLUMNS.join(',')}) VALUES (${SAMPLE_COLUMNS.map(() => '?').join(',')})`);
  db.exec('BEGIN');
  for (let i = 0; i < count; i++) ins.run(from + i * 10, 50, inW(i), 100, 0, 0, 0, 0, 0, null, 30);
  db.exec('COMMIT');
}

const hourly = (db: Db) => db.prepare('SELECT ts, in_w, ac_v_dv FROM samples_1h ORDER BY ts').all() as { ts: number; in_w: number; ac_v_dv: number | null }[];

describe('rollupHours', () => {
  it('averages finished hours and remembers where it stopped', () => {
    const db = openDb(':memory:');
    seed10s(db, OCT1, 360 * 3, (i) => (i < 360 ? 100 : i < 720 ? 200 : 300));
    // The third hour ended only 60 s ago: its last rows may still sit in the recorder's buffer.
    expect(rollupHours(db, OCT1 + 3 * 3600 + 60)).toBe(2);
    expect(hourly(db)).toEqual([
      { ts: OCT1, in_w: 100, ac_v_dv: null },
      { ts: OCT1 + 3600, in_w: 200, ac_v_dv: null },
    ]);
    expect(rolledUntil(db)).toBe(OCT1 + 7200);
    expect(rollupHours(db, OCT1 + 3 * 3600 + 200)).toBe(1);
    expect(hourly(db).map((r) => r.in_w)).toEqual([100, 200, 300]);
    expect(rollupHours(db, OCT1 + 3 * 3600 + 200)).toBe(0);
  });

  it('does nothing before the first sample', () => {
    const db = openDb(':memory:');
    expect(rollupHours(db, OCT1)).toBe(0);
    expect(rolledUntil(db)).toBeNull();
  });
});

describe('queryHistory over long ranges', () => {
  it('reads hourly rows and fills hours not rolled up yet from 10-second rows', () => {
    const db = openDb(':memory:');
    seed10s(db, OCT1, 360 * 3, (i) => (i < 360 ? 100 : i < 720 ? 200 : 300));
    rollupHours(db, OCT1 + 2 * 3600 + 200); // rolls the first two hours only
    const r = queryHistory(db, { from: OCT1 - 20 * 86_400, to: OCT1 + 3 * 3600, metrics: ['in_w'], points: 1000 });
    expect(r.table).toBe('samples_1h');
    expect(r.bucketSec).toBe(3600);
    expect(r.ts).toEqual([OCT1, OCT1 + 3600, OCT1 + 7200]);
    expect(r.series.in_w.avg).toEqual([100, 200, 300]);
  });

  it('keeps a year within the point budget', () => {
    const db = openDb(':memory:');
    const ins = db.prepare(`INSERT INTO samples_1h (${SAMPLE_COLUMNS.join(',')}) VALUES (${SAMPLE_COLUMNS.map(() => '?').join(',')})`);
    db.exec('BEGIN');
    for (let i = 0; i < 365 * 24; i++) ins.run(OCT1 - 365 * 86_400 + i * 3600, 60, 120, 110, 120, 110, 0, 0, 0, 2300, 28);
    db.exec('COMMIT');
    const r = queryHistory(db, { from: OCT1 - 365 * 86_400, to: OCT1, metrics: ['soc', 'out_w'], points: 600 });
    expect(r.table).toBe('samples_1h');
    expect(r.ts.length).toBeLessThanOrEqual(600);
    expect(r.ts.length).toBeGreaterThan(300);
    expect(r.bucketSec % 3600).toBe(0);
    expect(r.series.out_w.avg.every((v) => v === 110)).toBe(true);
  });
});
