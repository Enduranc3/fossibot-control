import { describe, expect, it } from 'vitest';
import type { HubEvent } from '../../shared/events.ts';
import { openDb } from './db.ts';
import { EventDetector, type GridStatus } from './event-detector.ts';
import { insertEvent } from './events-store.ts';
import { makeSnapshot } from './test-helpers.ts';

const T0 = 1_759_700_000;

function setup(opts: { requested?: [string, number][]; threshold?: number; initialGridPresent?: boolean | null } = {}) {
  const events: HubEvent[] = [];
  const grids: GridStatus[] = [];
  const det = new EventDetector({
    wasRequested: (r, v) => (opts.requested ?? []).some(([rr, vv]) => rr === r && vv === v),
    socLowThreshold: () => opts.threshold ?? 20,
    emit: (e) => events.push(e),
    initialGridPresent: opts.initialGridPresent,
    onGrid: (g) => grids.push({ ...g }),
  });
  const at = (sec: number, o: Parameters<typeof makeSnapshot>[1] = {}) => det.onSnapshot(makeSnapshot(sec * 1000, o));
  return { det, events, grids, at };
}

const OUTAGE = { acInW: 0, inW: 0, outW: 85 };
const types = (es: HubEvent[]) => es.map((e) => e.type);

describe('EventDetector — grid', () => {
  it('learns "present" silently, then reports a loss after 10 s and a return after 5 s', () => {
    const { det, events, at } = setup();
    for (let i = 0; i < 6; i++) at(T0 + i);
    expect(det.grid.present).toBe(true);
    expect(events).toHaveLength(0);
    for (let i = 10; i < 20; i++) at(T0 + i, OUTAGE);
    expect(events).toHaveLength(0);
    at(T0 + 20, OUTAGE);
    expect(events[0]).toMatchObject({ type: 'grid_lost', ts: T0 + 10, source: 'hub', data: { soc: 60, initial: false } });
    for (let i = 30; i <= 35; i++) at(T0 + i);
    expect(events[1]).toMatchObject({ type: 'grid_restored', ts: T0 + 30 });
  });

  it('resets the timer when the condition flaps', () => {
    const { events, at } = setup();
    for (let i = 0; i < 6; i++) at(T0 + i);
    for (let i = 10; i < 19; i++) at(T0 + i, OUTAGE);
    at(T0 + 19); // grid back for one report
    for (let i = 20; i < 29; i++) at(T0 + i, OUTAGE);
    expect(events).toHaveLength(0);
  });

  it('reports an outage that is already in progress at start as initial', () => {
    const { events, at } = setup();
    for (let i = 0; i <= 10; i++) at(T0 + i, OUTAGE);
    expect(events[0]).toMatchObject({ type: 'grid_lost', data: { initial: true } });
  });

  it('with initialGridPresent=false reports the return without a second loss', () => {
    const { events, at } = setup({ initialGridPresent: false });
    for (let i = 0; i <= 10; i++) at(T0 + i, OUTAGE);
    for (let i = 20; i <= 25; i++) at(T0 + i);
    expect(types(events)).toEqual(['grid_restored']);
  });

  it('stays unknown with no load and no input', () => {
    const { det, at } = setup();
    for (let i = 0; i < 30; i++) at(T0 + i, { acInW: 0, inW: 0, outW: 0 });
    expect(det.grid.present).toBeNull();
  });

  it('calls onGrid on every change', () => {
    const { grids, at } = setup();
    for (let i = 0; i < 6; i++) at(T0 + i);
    expect(grids).toEqual([{ present: true, sinceSec: T0 }]);
  });
});

describe('EventDetector — outputs, settings, faults, SoC', () => {
  it('attributes output changes to the app or the station', () => {
    const { events, at } = setup({ requested: [['acOn', 0]] });
    at(T0);
    at(T0 + 1, { acOn: false });
    at(T0 + 2, { acOn: false, dcOn: true });
    expect(events).toEqual([
      { ts: T0 + 1, type: 'output_changed', source: 'app', data: { output: 'ac', from: 1, to: 0 } },
      { ts: T0 + 2, type: 'output_changed', source: 'station', data: { output: 'dc', from: 0, to: 1 } },
    ]);
  });

  it('reports setting changes', () => {
    const { events, at } = setup();
    at(T0);
    at(T0 + 1, { registers: { chargePowerW: 500 } });
    expect(events[0]).toMatchObject({ type: 'setting_changed', data: { register: 'chargePowerW', from: 1200, to: 500 } });
  });

  it('reports faults set and cleared', () => {
    const { events, at } = setup();
    at(T0);
    at(T0 + 1, { faults: { bms: 4, pcs: 0, pv: 0 } });
    at(T0 + 2);
    expect(events.map((e) => [e.type, e.data])).toEqual([
      ['fault_set', { kind: 'bms', code: 4 }],
      ['fault_cleared', { kind: 'bms', code: 4 }],
    ]);
  });

  it('emits soc_low once and re-arms 5 % above the threshold', () => {
    const { events, at } = setup({ threshold: 20 });
    at(T0, { soc: 21 });
    at(T0 + 1, { soc: 20 });
    at(T0 + 2, { soc: 19 });
    at(T0 + 3, { soc: 24 });
    at(T0 + 4, { soc: 20 });
    at(T0 + 5, { soc: 25 });
    at(T0 + 6, { soc: 20 });
    expect(types(events)).toEqual(['soc_low', 'soc_low']);
  });
});

describe('EventDetector — link', () => {
  it('ignores the first up, then reports loss and recovery', () => {
    const { det, events } = setup();
    det.onLinkState('up', T0);
    det.onLinkState('down', T0 + 10);
    det.onLinkState('up', T0 + 20);
    expect(events.map((e) => [e.type, e.ts])).toEqual([
      ['link_lost', T0 + 10],
      ['link_restored', T0 + 20],
    ]);
  });
});

describe('insertEvent', () => {
  it('stores the event and returns its id', () => {
    const db = openDb(':memory:');
    const id = insertEvent(db, { ts: T0, type: 'hub_started', source: 'hub', data: { v: 1 } });
    expect(id).toBe(1);
    expect(db.prepare('SELECT ts, type, source, data FROM events').get()).toEqual({
      ts: T0,
      type: 'hub_started',
      source: 'hub',
      data: '{"v":1}',
    });
  });
});
