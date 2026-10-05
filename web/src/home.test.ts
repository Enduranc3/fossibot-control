// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeSnapshot } from '../../hub/src/test-helpers.ts';
import { createBatteryRing } from './components/battery-ring.ts';
import type { UiDeps } from './deps.ts';
import { createHomePage } from './pages/home.ts';
import { createAppStore } from './store.ts';
import type { StateView } from './types.ts';

beforeEach(() => vi.stubGlobal('matchMedia', () => ({ matches: true }))); // no tweening in tests
afterEach(() => vi.unstubAllGlobals());

const VIEW: StateView = {
  link: 'up',
  snapshot: makeSnapshot(Date.now(), { soc: 60, inW: 86, outW: 86, acInW: 86, acOutW: 86 }),
  grid: { present: true, sinceSec: Math.floor(Date.now() / 1000) - 3600 },
  outage: null,
  forecast: { capacityWh: 1024, avgLoadW: 85, runtimeHours: 7.2, stationRemainingMin: 3600 },
  today: { gridInWh: 1240, solarInWh: 0, outWh: 980 },
};

function deps(): UiDeps {
  return {
    store: createAppStore(),
    api: {} as UiDeps['api'],
    run: vi.fn(async () => ({})),
    confirm: vi.fn(async () => true),
    notify: vi.fn(),
    onLoggedOut: vi.fn(),
  };
}

describe('battery gauge', () => {
  it('shows the charge, tone and flow, and a dash without data', () => {
    const ring = createBatteryRing();
    ring.update(60, 'bypass');
    expect(ring.el.textContent).toContain('60');
    expect(ring.el.textContent).toContain('Від мережі');
    expect(ring.el.dataset.tone).toBe('ok');
    const value = ring.el.querySelector('.gauge-value') as SVGCircleElement;
    expect(Number(value.style.strokeDashoffset)).toBeGreaterThan(0);
    ring.update(15, 'discharging');
    expect(ring.el.dataset.tone).toBe('bad');
    ring.update(null, 'idle');
    expect(ring.el.textContent).toContain('—');
    expect(ring.el.textContent).toContain('Немає даних');
  });
});

describe('home page', () => {
  it('renders without any data and never prints NaN or undefined', () => {
    const d = deps();
    const page = createHomePage(d);
    expect(page.el.textContent).not.toMatch(/NaN|undefined|null/);
    expect(page.el.textContent).toContain('Очікуємо дані');
    page.destroy?.();
  });

  it('renders live values and updates when the store changes', () => {
    const d = deps();
    d.store.set({ view: VIEW, hub: 'online' });
    const page = createHomePage(d);
    const text = () => page.el.textContent ?? '';
    expect(text()).toContain('Мережа є · 1 год 00 хв');
    expect(text()).toContain('Якщо зникне світло — вистачить на ~7 год 12 хв');
    expect(text()).toContain('1.24');
    expect(text()).toContain('0.98');
    expect(page.el.querySelector('.power-in .power-val')?.textContent).toContain('86');
    d.store.set({ view: { ...VIEW, snapshot: makeSnapshot(Date.now(), { soc: 59, inW: 0, outW: 120, acInW: 0, acOutW: 120, acV: null }) } });
    expect(page.el.querySelector('.power-out .power-val')?.textContent).toContain('120');
    expect(text()).toContain('Від батареї');
    expect(text()).not.toMatch(/NaN|undefined/);
    page.destroy?.();
  });
});
