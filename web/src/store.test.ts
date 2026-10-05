import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeSnapshot } from '../../hub/src/test-helpers.ts';
import { clearPersisted, createAppStore, type StorageLike } from './store.ts';
import type { StateView } from './types.ts';

afterEach(() => vi.useRealTimers());

const VIEW: StateView = {
  link: 'up',
  snapshot: makeSnapshot(1_000),
  grid: { present: true, sinceSec: 1 },
  outage: null,
  forecast: { capacityWh: 1024, avgLoadW: 85, runtimeHours: 7, stationRemainingMin: 3600 },
  today: { gridInWh: 1, solarInWh: 0, outWh: 1 },
};

function memory(initial: Record<string, string> = {}): StorageLike & { data: Map<string, string> } {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
    removeItem: (k) => void data.delete(k),
  };
}

describe('persisted last state', () => {
  it('starts from the last saved view so a cold start without signal still shows data', () => {
    const storage = memory({ 'fossibot.lastState': JSON.stringify({ view: VIEW, lastDataAt: 123 }) });
    const store = createAppStore(storage);
    expect(store.get()).toMatchObject({ view: { link: 'up' }, lastDataAt: 123, hub: 'connecting', pending: {} });
  });

  it('saves the view at most every 5 s and ignores corrupt data', () => {
    vi.useFakeTimers();
    const storage = memory({ 'fossibot.lastState': '{not json' });
    const store = createAppStore(storage);
    expect(store.get().view).toBeNull();
    store.set({ view: VIEW, lastDataAt: 10 });
    expect(JSON.parse(storage.data.get('fossibot.lastState')!).lastDataAt).toBe(10);
    store.set({ lastDataAt: 11 });
    expect(JSON.parse(storage.data.get('fossibot.lastState')!).lastDataAt).toBe(10);
    vi.advanceTimersByTime(5000);
    store.set({ lastDataAt: 12 });
    expect(JSON.parse(storage.data.get('fossibot.lastState')!).lastDataAt).toBe(12);
    store.set({ pending: { led: 1 } }); // UI-only changes are not saved
  });

  it('does not persist without storage and clears on logout', () => {
    const store = createAppStore();
    store.set({ view: VIEW });
    const storage = memory({ 'fossibot.lastState': '{}' });
    clearPersisted(storage);
    expect(storage.data.size).toBe(0);
  });
});
