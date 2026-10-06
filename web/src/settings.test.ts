// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeSnapshot } from '../../hub/src/test-helpers.ts';
import { WRITABLE } from '../../shared/commands.ts';
import { ApiError } from './api.ts';
import { createSettingRow } from './components/setting-row.ts';
import type { UiDeps } from './deps.ts';
import { createSettingsPage } from './pages/settings.ts';
import { STATION_SETTINGS, type SettingDef } from './settings-def.ts';
import { createAppStore } from './store.ts';
import type { StateView } from './types.ts';

afterEach(() => {
  document.body.innerHTML = '';
});

const flush = () => new Promise((r) => setTimeout(r, 0));

function view(registers: Record<string, number | string> = {}): StateView {
  return {
    link: 'up',
    snapshot: makeSnapshot(0, { registers: { chargeLimit: 60, chargePowerW: 1200, screenTimeout: 1, keySoundOff: 0, ecoMode: 0, firmwareVersion: '10-01-02-07', ...registers } }),
    grid: { present: true, sinceSec: 0 },
    outage: null,
    forecast: { capacityWh: 1024, avgLoadW: null, runtimeHours: null, stationRemainingMin: null },
    today: { gridInWh: 0, solarInWh: 0, outWh: 0 },
  };
}

function deps(over: Partial<UiDeps> = {}): UiDeps {
  const store = createAppStore();
  store.set({ view: view(), hub: 'online' });
  const api = {
    updatePrefs: vi.fn(async () => ({})),
    hubInfo: vi.fn(async () => ({ version: 'v0.4.0', dbBytes: 1e8, budgetBytes: 1e10, backup: { dir: '/b', last: null } })),
    prefs: vi.fn(async () => ({
      socLowThreshold: 20,
      capacityWh: 1024,
      notify: { grid_lost: true, grid_restored: true, soc_low: true, link_lost: true, fault_set: true, output_changed: false, setting_changed: false, hub_started: false },
    })),
    sessions: vi.fn(async () => [
      { id: 'a', createdTs: 1, lastSeenTs: 1_759_700_000, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0) Version/18.0 Safari/604.1', current: true },
      { id: 'b', createdTs: 1, lastSeenTs: 1_759_600_000, userAgent: 'Mozilla/5.0 (Macintosh) Chrome/130.0 Safari/537.36', current: false },
    ]),
    revokeSession: vi.fn(async () => ({ ok: true })),
    logout: vi.fn(async () => ({ ok: true })),
  } as unknown as UiDeps['api'];
  return { store, api, run: vi.fn(async () => ({ ok: true })), confirm: vi.fn(async () => true), notify: vi.fn(), onLoggedOut: vi.fn(), ...over };
}

const def = (register: string) => STATION_SETTINGS.find((d) => d.register === register) as SettingDef;

describe('station settings definitions', () => {
  it('only use writable registers within the allowed ranges', () => {
    for (const d of STATION_SETTINGS) {
      const spec = WRITABLE[d.register];
      expect(spec, d.register).toBeDefined();
      if (d.kind === 'slider') {
        expect(d.min).toBeGreaterThanOrEqual(spec.min);
        expect(d.max).toBeLessThanOrEqual(spec.max);
      }
      if (d.kind === 'select' || d.kind === 'segmented') {
        for (const [v] of d.options) expect(v >= spec.min && v <= spec.max, `${d.register}=${v}`).toBe(true);
      }
    }
  });
});

describe('setting rows', () => {
  it('slider shows the station value and sends the new one on release', async () => {
    const d = deps();
    const row = createSettingRow(def('chargeLimit'), d);
    row.update(d.store.get());
    const input = row.el.querySelector('input') as HTMLInputElement;
    expect(input.value).toBe('60');
    expect(row.el.textContent).toContain('60 %');
    input.value = '85';
    input.dispatchEvent(new Event('input'));
    expect(row.el.textContent).toContain('85 %');
    input.dispatchEvent(new Event('change'));
    await flush();
    expect(d.run).toHaveBeenCalledWith('chargeLimit', 85);
  });

  it('slider goes back to the station value when the command fails', async () => {
    const d = deps({ run: vi.fn(async () => Promise.reject(new ApiError(503, 'station_offline', "Станція не на зв'язку"))) });
    const row = createSettingRow(def('chargeLimit'), d);
    row.update(d.store.get());
    const input = row.el.querySelector('input') as HTMLInputElement;
    input.value = '90';
    input.dispatchEvent(new Event('change'));
    await flush();
    expect(d.notify).toHaveBeenCalledWith("Станція не на зв'язку", 'error');
    expect(input.value).toBe('60');
  });

  it('select and inverted switch send the right register values', async () => {
    const d = deps();
    const select = createSettingRow(def('screenTimeout'), d);
    select.update(d.store.get());
    const sel = select.el.querySelector('select') as HTMLSelectElement;
    expect(sel.value).toBe('1');
    sel.value = '3';
    sel.dispatchEvent(new Event('change'));
    await flush();
    expect(d.run).toHaveBeenCalledWith('screenTimeout', 3);
    const sw = createSettingRow(def('keySoundOff'), d);
    sw.update(d.store.get());
    const btn = sw.el.querySelector('[role="switch"]') as HTMLButtonElement;
    expect(btn.getAttribute('aria-checked')).toBe('true'); // keySoundOff=0 → sound on
    btn.click();
    await flush();
    expect(d.run).toHaveBeenLastCalledWith('keySoundOff', 1);
  });
});

describe('settings page', () => {
  it('renders all sections, hub info and sessions, saves capacity and logs out', async () => {
    const d = deps();
    const page = createSettingsPage(d);
    document.body.append(page.el);
    await flush();
    const text = page.el.textContent ?? '';
    expect(text).toContain('Станція');
    expect(text).toContain('Сповіщення');
    expect(text).toContain('Хаб');
    expect(text).toContain('Інформація');
    expect(text).toContain('10-01-02-07');
    expect(text).toContain('iPhone · Safari');
    expect(text).toContain('Цей пристрій');
    expect(text).toContain('0.10 ГБ з 10 ГБ');
    expect(text).not.toMatch(/NaN|undefined/);
    const capacity = page.el.querySelector('input[aria-label="Ємність батареї"]') as HTMLInputElement;
    expect(capacity.value).toBe('1024');
    capacity.value = '1000';
    capacity.dispatchEvent(new Event('change'));
    await flush();
    expect(d.api.updatePrefs).toHaveBeenCalledWith({ capacityWh: 1000 });
    (page.el.querySelector('[data-action="revoke"]') as HTMLButtonElement).click();
    await flush();
    expect(d.api.revokeSession).toHaveBeenCalledWith('b');
    (page.el.querySelector('[data-action="logout"]') as HTMLButtonElement).click();
    await flush();
    expect(d.api.logout).toHaveBeenCalled();
    expect(d.onLoggedOut).toHaveBeenCalled();
    page.destroy?.();
  });
});
