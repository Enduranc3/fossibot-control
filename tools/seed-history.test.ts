import { describe, expect, it } from 'vitest';
import { openDb } from '../hub/src/db.ts';
import { listEvents, listOutages, queryEnergy, queryHistory } from '../hub/src/history.ts';
import { outageWindows, prng, seedHistory } from './seed-history.ts';

const NOW = Math.floor(new Date(2026, 9, 6, 12).getTime() / 1000);

describe('seedHistory', () => {
  it('writes hourly, 10-second and 1-second rows with consistent outages and ordered events', () => {
    const db = openDb(':memory:');
    const r = seedHistory(db, { nowSec: NOW, days: 20, detailDays: 2 });
    expect(r.rows10s).toBeGreaterThanOrEqual(2 * 8640 - 360);
    expect(r.rows1h).toBeGreaterThanOrEqual(17 * 24);
    expect(r.rows1s).toBe(6 * 3600);
    const outages = listOutages(db, 0, NOW + 1);
    expect(outages.length).toBe(r.outages);
    expect(r.outages).toBeGreaterThan(5);
    for (const o of outages) {
      expect(o.endTs).not.toBeNull();
      expect(o.endTs ?? 0).toBeGreaterThan(o.startTs);
      expect(o.endTs ?? Infinity).toBeLessThan(NOW - 3600);
    }
    const hist = queryHistory(db, { from: NOW - 20 * 86_400, to: NOW, metrics: ['soc', 'in_w', 'out_w'], points: 400 });
    expect(hist.table).toBe('samples_1h');
    const socs = hist.series.soc.avg.filter((v): v is number => v !== null);
    expect(socs.length).toBeGreaterThan(200);
    expect(Math.min(...socs)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...socs)).toBeLessThanOrEqual(100);
    expect(queryEnergy(db, { from: NOW - 20 * 86_400, to: NOW, bucket: 'day' }).length).toBeGreaterThanOrEqual(20);
    const { events } = listEvents(db, { limit: 200 });
    for (let i = 1; i < events.length; i++) expect(events[i - 1].ts).toBeGreaterThanOrEqual(events[i].ts);
  });

  it('draws the same history for the same seed', () => {
    const a = outageWindows(0, 30 * 86_400, prng(7));
    const b = outageWindows(0, 30 * 86_400, prng(7));
    expect(a).toEqual(b);
    for (let i = 1; i < a.length; i++) expect(a[i][0]).toBeGreaterThan(a[i - 1][1]);
  });
});
