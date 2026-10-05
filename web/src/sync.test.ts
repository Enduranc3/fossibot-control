import { describe, expect, it, vi } from 'vitest';
import { makeSnapshot } from '../../hub/src/test-helpers.ts';
import { createAppStore } from './store.ts';
import { applyLive, checkSessionAfterReject, hubStatusFor, shouldRefreshOnEvent } from './sync.ts';
import type { StateView } from './types.ts';

const VIEW: StateView = {
  link: 'down',
  snapshot: null,
  grid: { present: null, sinceSec: null },
  outage: null,
  forecast: { capacityWh: 1024, avgLoadW: null, runtimeHours: null, stationRemainingMin: null },
  today: { gridInWh: 0, solarInWh: 0, outWh: 0 },
};

describe('applyLive', () => {
  it('replaces the view on hello and patches it on later messages', () => {
    const store = createAppStore();
    applyLive(store, { type: 'telemetry', snapshot: makeSnapshot(1) }, 5);
    expect(store.get().view).toBeNull(); // nothing to patch before hello
    applyLive(store, { type: 'hello', state: VIEW }, 10);
    expect(store.get()).toMatchObject({ view: VIEW, lastDataAt: 10, hub: 'online' });
    const snap = makeSnapshot(2);
    applyLive(store, { type: 'telemetry', snapshot: snap }, 20);
    expect(store.get().view).toMatchObject({ snapshot: snap, link: 'up' });
    applyLive(store, { type: 'grid', present: false, sinceSec: 99 }, 30);
    expect(store.get().view?.grid).toEqual({ present: false, sinceSec: 99 });
    applyLive(store, { type: 'link', state: 'down' }, 40);
    expect(store.get().view?.link).toBe('down');
    expect(store.get().lastDataAt).toBe(40);
  });
});

describe('helpers', () => {
  it('maps socket status to hub connection state', () => {
    expect(hubStatusFor('connecting', 'open')).toBe('online');
    expect(hubStatusFor('online', 'closed')).toBe('offline');
    expect(hubStatusFor('offline', 'connecting')).toBe('offline');
    expect(hubStatusFor('connecting', 'connecting')).toBe('connecting');
  });

  it('refreshes the state on grid events only', () => {
    expect(shouldRefreshOnEvent({ type: 'event', event: { ts: 1, type: 'grid_lost', source: 'hub', data: {} } })).toBe(true);
    expect(shouldRefreshOnEvent({ type: 'event', event: { ts: 1, type: 'output_changed', source: 'app', data: {} } })).toBe(false);
    expect(shouldRefreshOnEvent({ type: 'link', state: 'up' })).toBe(false);
  });

  it('sends the user to login when a rejected socket means the session is gone', async () => {
    const out = vi.fn();
    await checkSessionAfterReject(async () => ({ loggedIn: false }), out);
    expect(out).toHaveBeenCalledTimes(1);
    await checkSessionAfterReject(async () => ({ loggedIn: true }), out);
    await checkSessionAfterReject(async () => Promise.reject(new Error('offline')), out);
    expect(out).toHaveBeenCalledTimes(1);
  });
});
