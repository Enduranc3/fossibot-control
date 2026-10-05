// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';
import { makeSnapshot } from '../../hub/src/test-helpers.ts';
import { ApiError } from './api.ts';
import { createOutputs } from './components/outputs.ts';
import type { UiDeps } from './deps.ts';
import { AC_OFF_CONFIRM, canControl, sendCommand, setLed, toggleOutput } from './outputs.ts';
import { createAppStore } from './store.ts';
import type { StateView } from './types.ts';

function view(o: Parameters<typeof makeSnapshot>[1] = {}): StateView {
  return {
    link: 'up',
    snapshot: makeSnapshot(0, o),
    grid: { present: true, sinceSec: 0 },
    outage: null,
    forecast: { capacityWh: 1024, avgLoadW: null, runtimeHours: null, stationRemainingMin: null },
    today: { gridInWh: 0, solarInWh: 0, outWh: 0 },
  };
}

function deps(over: Partial<UiDeps> = {}): UiDeps {
  const store = createAppStore();
  store.set({ view: view({ acOn: true, dcOn: false, led: 0 }), hub: 'online' });
  return {
    store,
    api: {} as UiDeps['api'],
    run: vi.fn(async () => ({ ok: true })),
    confirm: vi.fn(async () => true),
    notify: vi.fn(),
    onLoggedOut: vi.fn(),
    ...over,
  };
}

describe('output commands', () => {
  it('asks before switching AC off and does nothing when declined', async () => {
    const d = deps({ confirm: vi.fn(async () => false) });
    expect(await toggleOutput(d, 'acOn')).toBe(false);
    expect(d.confirm).toHaveBeenCalledWith(AC_OFF_CONFIRM);
    expect(d.run).not.toHaveBeenCalled();
  });

  it('switches AC off after confirmation and DC on without asking', async () => {
    const d = deps();
    expect(await toggleOutput(d, 'acOn')).toBe(true);
    expect(d.run).toHaveBeenCalledWith('acOn', 0);
    expect(await toggleOutput(d, 'dcOn')).toBe(true);
    expect(d.run).toHaveBeenLastCalledWith('dcOn', 1);
    expect(d.confirm).toHaveBeenCalledTimes(1);
  });

  it('ignores a second tap while the first command is pending', async () => {
    let release!: () => void;
    const d = deps({ run: vi.fn(() => new Promise<unknown>((r) => (release = () => r({})))) });
    const first = toggleOutput(d, 'dcOn');
    await Promise.resolve();
    expect(d.store.get().pending).toEqual({ dcOn: 1 });
    expect(await toggleOutput(d, 'dcOn')).toBe(false);
    release();
    expect(await first).toBe(true);
    expect(d.run).toHaveBeenCalledTimes(1);
    expect(d.store.get().pending).toEqual({});
  });

  it('reports a failed command and clears the pending state', async () => {
    const d = deps({ run: vi.fn(async () => Promise.reject(new ApiError(409, 'not_confirmed', 'Станція не підтвердила команду'))) });
    expect(await setLed(d, 2)).toBe(false);
    expect(d.notify).toHaveBeenCalledWith('Станція не підтвердила команду', 'error');
    expect(d.store.get().pending).toEqual({});
  });

  it('refuses commands without data, with the station down or the hub offline', async () => {
    const d = deps();
    expect(canControl(d.store.get())).toBe(true);
    d.store.set({ hub: 'offline' });
    expect(canControl(d.store.get())).toBe(false);
    expect(await sendCommand(d, 'led', 1)).toBe(false);
    d.store.set({ hub: 'online', view: { ...view(), link: 'down' } });
    expect(canControl(d.store.get())).toBe(false);
    d.store.set({ view: null });
    expect(await toggleOutput(d, 'dcOn')).toBe(false);
    expect(d.run).not.toHaveBeenCalled();
  });
});

describe('outputs view', () => {
  it('shows each output state, pending and LED modes, and disables tiles offline', () => {
    const d = deps();
    const out = createOutputs(d);
    out.update(d.store.get());
    const tile = (k: string) => out.el.querySelector(`[data-output="${k}"]`) as HTMLButtonElement;
    expect(tile('acOn').dataset.on).toBe('true');
    expect(tile('dcOn').dataset.on).toBe('false');
    expect(tile('acOn').textContent).toContain('Увімкнено');
    expect((out.el.querySelector('.led-modes') as HTMLElement).hidden).toBe(true);
    d.store.set({ view: view({ acOn: true, led: 2 }), pending: { dcOn: 1 } });
    out.update(d.store.get());
    expect(tile('dcOn').dataset.pending).toBe('true');
    expect(tile('dcOn').textContent).toContain('Зачекайте');
    expect((out.el.querySelector('.led-modes') as HTMLElement).hidden).toBe(false);
    expect(out.el.querySelector('.led-modes [aria-pressed="true"]')?.textContent).toBe('SOS');
    d.store.set({ hub: 'offline' });
    out.update(d.store.get());
    expect(tile('acOn').disabled).toBe(true);
  });
});
