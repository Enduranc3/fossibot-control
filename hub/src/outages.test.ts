import { describe, expect, it } from 'vitest';
import { openDb } from './db.ts';
import { OutageTracker } from './outages.ts';

const T0 = 1_759_700_000;
const delta = (outWh: number) => ({ hourTs: 0, gridInWh: 0, solarInWh: 0, outWh, acOutWh: outWh, dcOutWh: 0, usbOutWh: 0 });

describe('OutageTracker', () => {
  it('opens on grid_lost, accumulates energy and closes on grid_restored', () => {
    const db = openDb(':memory:');
    const t = new OutageTracker(db);
    t.onEvent({ ts: T0, type: 'grid_lost', source: 'hub', data: { soc: 80 } });
    t.addEnergy(delta(10));
    t.addEnergy(delta(5));
    const done = t.onEvent({ ts: T0 + 600, type: 'grid_restored', source: 'hub', data: { soc: 70 } });
    expect(done).toMatchObject({ startTs: T0, endTs: T0 + 600, socStart: 80, socEnd: 70, outWh: 15 });
    expect(t.ongoing()).toBeNull();
    expect(db.prepare('SELECT start_ts, end_ts, soc_start, soc_end, out_wh FROM outages').get()).toEqual({
      start_ts: T0,
      end_ts: T0 + 600,
      soc_start: 80,
      soc_end: 70,
      out_wh: 15,
    });
  });

  it('resumes an open outage after a restart and does not open a second one', () => {
    const db = openDb(':memory:');
    const a = new OutageTracker(db);
    a.onEvent({ ts: T0, type: 'grid_lost', source: 'hub', data: { soc: 80 } });
    a.addEnergy(delta(7));
    a.persist();
    const b = new OutageTracker(db);
    expect(b.ongoing()).toMatchObject({ startTs: T0, outWh: 7 });
    b.onEvent({ ts: T0 + 60, type: 'grid_lost', source: 'hub', data: { soc: 79, initial: true } });
    expect((db.prepare('SELECT count(*) AS n FROM outages').get() as { n: number }).n).toBe(1);
  });

  it('ignores energy and restores when there is no open outage', () => {
    const db = openDb(':memory:');
    const t = new OutageTracker(db);
    t.addEnergy(delta(10));
    expect(t.onEvent({ ts: T0, type: 'grid_restored', source: 'hub', data: {} })).toBeNull();
  });

  it('keeps the outage in memory while the database is read-only and writes it later', () => {
    const db = openDb(':memory:');
    const t = new OutageTracker(db);
    db.exec('PRAGMA query_only = 1');
    expect(t.onEvent({ ts: T0, type: 'grid_lost', source: 'hub', data: { soc: 80 } })).toBeNull();
    expect(t.ongoing()).toMatchObject({ startTs: T0, socStart: 80 });
    t.addEnergy(delta(12));
    const done = t.onEvent({ ts: T0 + 300, type: 'grid_restored', source: 'hub', data: { soc: 75 } });
    expect(done).toMatchObject({ startTs: T0, endTs: T0 + 300, outWh: 12 });
    expect(() => t.persist()).toThrow();
    db.exec('PRAGMA query_only = 0');
    t.persist();
    expect(db.prepare('SELECT start_ts, end_ts, soc_start, soc_end, out_wh FROM outages').all()).toEqual([
      { start_ts: T0, end_ts: T0 + 300, soc_start: 80, soc_end: 75, out_wh: 12 },
    ]);
  });
});

