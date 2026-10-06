import { describe, expect, it } from 'vitest';
import { SAMPLE_COLUMNS, openDb, type Db } from './db.ts';
import { insertEvent } from './events-store.ts';
import {
  energyTotalsSince,
  exportCsv,
  listEvents,
  listOutages,
  localMidnight,
  outageCalendar,
  queryEnergy,
  queryHistory,
} from './history.ts';

// Tests run with TZ=Europe/Kyiv (UTC+3 in October 2026).
const OCT1 = Math.floor(new Date(2026, 9, 1).getTime() / 1000);

function seedSamples(db: Db, table: string, from: number, count: number, step: number) {
  const ins = db.prepare(`INSERT INTO ${table} (${SAMPLE_COLUMNS.join(',')}) VALUES (${SAMPLE_COLUMNS.map(() => '?').join(',')})`);
  db.exec('BEGIN');
  for (let i = 0; i < count; i++) ins.run(from + i * step, 50, i % 100, 100, 0, 0, 0, 0, 0, 2300, 30);
  db.exec('COMMIT');
}

describe('queryHistory', () => {
  it('uses 1-second samples for short ranges with min/avg/max per bucket', () => {
    const db = openDb(':memory:');
    seedSamples(db, 'samples_1s', OCT1, 3600, 1);
    const r = queryHistory(db, { from: OCT1, to: OCT1 + 3600, metrics: ['in_w', 'soc'], points: 60 });
    expect(r.table).toBe('samples_1s');
    expect(r.bucketSec).toBe(60);
    expect(r.ts).toHaveLength(60);
    expect(r.series.in_w.min[0]).toBe(0);
    expect(r.series.in_w.max[0]).toBe(59);
    expect(r.series.soc.avg[0]).toBe(50);
  });

  it('uses 10-second samples for a week and stays within the point budget', () => {
    const db = openDb(':memory:');
    seedSamples(db, 'samples_10s', OCT1, 8640 * 3, 10); // 3 days of data
    const r = queryHistory(db, { from: OCT1 - 4 * 86_400, to: OCT1 + 3 * 86_400, metrics: ['out_w'], points: 500 });
    expect(r.table).toBe('samples_10s');
    expect(r.ts.length).toBeLessThanOrEqual(500);
    expect(r.bucketSec % 10).toBe(0);
  });
});

describe('energy', () => {
  it('groups hourly energy by local day and sums totals', () => {
    const db = openDb(':memory:');
    const ins = db.prepare('INSERT INTO energy_hourly (hour_ts, grid_in_wh, out_wh) VALUES (?, ?, ?)');
    for (let h = 0; h < 48; h++) ins.run(OCT1 + h * 3600, 10, 5);
    const days = queryEnergy(db, { from: OCT1, to: OCT1 + 2 * 86_400, bucket: 'day' });
    expect(days.map((d) => [d.label, d.gridInWh, d.outWh])).toEqual([
      ['2026-10-01', 240, 120],
      ['2026-10-02', 240, 120],
    ]);
    expect(energyTotalsSince(db, OCT1 + 86_400)).toEqual({ gridInWh: 240, solarInWh: 0, outWh: 120 });
    expect(localMidnight(OCT1 + 5 * 3600)).toBe(OCT1);
  });
});

describe('outages', () => {
  it('lists overlapping outages and builds a clipped calendar', () => {
    const db = openDb(':memory:');
    const ins = db.prepare('INSERT INTO outages (start_ts, end_ts, soc_start, soc_end, out_wh) VALUES (?, ?, ?, ?, ?)');
    ins.run(OCT1 + 86_400 - 3600, OCT1 + 86_400 + 1800, 80, 70, 100); // 23:00 → 00:30 next day
    ins.run(OCT1 + 5 * 86_400, null, 70, null, 0); // ongoing since Oct 6 00:00
    expect(listOutages(db, OCT1, OCT1 + 2 * 86_400)).toHaveLength(1);
    const cal = outageCalendar(db, '2026-10', OCT1 + 5 * 86_400 + 7200);
    expect(cal.days).toHaveLength(31);
    expect(cal.days[0]).toEqual({ date: '2026-10-01', outageSec: 3600 });
    expect(cal.days[1]).toEqual({ date: '2026-10-02', outageSec: 1800 });
    expect(cal.days[5]).toEqual({ date: '2026-10-06', outageSec: 7200 });
    expect(cal).toMatchObject({ count: 2, totalSec: 3600 + 1800 + 7200, longestSec: 7200 });
  });
});

describe('listEvents', () => {
  it('filters by type and pages by cursor, newest first', () => {
    const db = openDb(':memory:');
    for (let i = 0; i < 5; i++) insertEvent(db, { ts: OCT1 + i, type: i % 2 ? 'grid_lost' : 'output_changed', source: 'hub', data: { i } });
    const first = listEvents(db, { limit: 2 });
    expect(first.events.map((e) => e.data.i)).toEqual([4, 3]);
    const second = listEvents(db, { limit: 2, cursor: first.nextCursor! });
    expect(second.events.map((e) => e.data.i)).toEqual([2, 1]);
    expect(listEvents(db, { limit: 10, types: ['grid_lost'] }).events).toHaveLength(2);
    expect(listEvents(db, { limit: 10, from: OCT1 + 3 }).events).toHaveLength(2);
  });
});

describe('exportCsv', () => {
  it('escapes values and limits the samples range', () => {
    const db = openDb(':memory:');
    insertEvent(db, { ts: OCT1, type: 'setting_changed', source: 'app', data: { note: 'a,"b"' } });
    const csv = exportCsv(db, 'events', OCT1 - 1, OCT1 + 1);
    expect(csv.split('\n')[0]).toBe('id,ts,type,source,data');
    expect(csv).toContain('"{""note"":""a,\\""b\\""""}"');
    expect(() => exportCsv(db, 'samples', OCT1, OCT1 + 40 * 86_400)).toThrow('range_too_large');
    seedSamples(db, 'samples_10s', OCT1, 3, 10);
    expect(exportCsv(db, 'samples', OCT1, OCT1 + 60).trim().split('\n')).toHaveLength(4);
  });
});
