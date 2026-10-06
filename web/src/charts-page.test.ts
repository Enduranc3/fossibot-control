// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from './api.ts';
import type { UiDeps } from './deps.ts';
import { CHART_METRICS, CHART_POINTS, createChartsPage } from './pages/charts.ts';
import { createAppStore } from './store.ts';
import type { EnergyRow, HistoryResult, Outage } from './types.ts';

afterEach(() => {
  document.body.replaceChildren();
  vi.useRealTimers();
});

const NOW = Math.floor(new Date(2026, 9, 6, 18).getTime() / 1000);
const flush = () => new Promise((r) => setTimeout(r, 0));
const ser = (avg: (number | null)[]) => ({ avg, min: avg, max: avg });
const hist = (from: number): HistoryResult => ({
  table: 'samples_10s',
  bucketSec: 600,
  ts: [from, from + 600, from + 1200],
  series: { soc: ser([80, 79, 78]), in_w: ser([300, 0, 0]), out_w: ser([120, 130, 125]), ac_in_w: ser([300, 0, 0]), solar_w: ser([0, 0, 0]) },
});
const energyRow = (ts: number, inWh: number, outWh: number): EnergyRow => ({
  ts,
  label: '',
  gridInWh: inWh,
  solarInWh: 0,
  outWh,
  acOutWh: outWh,
  dcOutWh: 0,
  usbOutWh: 0,
});
const OUTAGES: Outage[] = [{ id: 1, startTs: NOW - 5 * 3600, endTs: NOW - 3 * 3600, socStart: 90, socEnd: 70, outWh: 300 }];

function deferred<T>() {
  let resolve: (v: T) => void = () => {};
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve: (v: T) => resolve(v) };
}

function setup(over: Record<string, unknown> = {}) {
  const api = {
    history: vi.fn(async (from: number) => hist(from)),
    energy: vi.fn(async (_from: number, _to: number, bucket: string) =>
      bucket === 'hour' ? [energyRow(NOW - 3600, 1500, 900)] : [energyRow(NOW - 86_400, 7000, 5000)],
    ),
    outages: vi.fn(async () => OUTAGES),
    ...over,
  };
  const deps = { store: createAppStore(), api, run: vi.fn(), confirm: vi.fn(), notify: vi.fn(), onLoggedOut: vi.fn() } as unknown as UiDeps;
  const page = createChartsPage(deps, { now: () => NOW });
  document.body.append(page.el);
  return { api, page, el: page.el };
}

const click = (el: HTMLElement, selector: string) => (el.querySelector(selector) as HTMLButtonElement).click();
const stats = (el: HTMLElement) => [...el.querySelectorAll('.period-stats .stat-v')].map((s) => s.textContent);

describe('charts page', () => {
  it('loads the last day with hourly energy and fills the stats and three charts', async () => {
    const { api, el } = setup();
    await flush();
    expect(api.history).toHaveBeenCalledWith(NOW - 86_400, NOW, CHART_METRICS, CHART_POINTS);
    expect(api.energy.mock.calls[0][2]).toBe('hour');
    expect(el.querySelector('.period-label')?.textContent).toBe('Остання доба');
    expect(stats(el)).toEqual(['1.50', '0.90', '2 год 00 хв']);
    expect(el.querySelectorAll('.chart-card')).toHaveLength(3);
    expect(el.querySelectorAll('.chart-line')).toHaveLength(3);
    expect(el.querySelectorAll('.chart-band')).toHaveLength(2); // the outage on both line charts
    expect(el.querySelector('[data-preset="day"]')?.getAttribute('aria-pressed')).toBe('true');
    expect((el.querySelector('[aria-label="Пізніше"]') as HTMLButtonElement).disabled).toBe(true);
  });

  it('asks for daily energy for a week', async () => {
    const { api, el } = setup();
    await flush();
    click(el, '[data-preset="week"]');
    await flush();
    expect(api.history).toHaveBeenLastCalledWith(NOW - 7 * 86_400, NOW, CHART_METRICS, CHART_POINTS);
    expect(api.energy.mock.lastCall?.[2]).toBe('day');
    expect(stats(el)[0]).toBe('7.00');
  });

  it('a slow earlier answer never replaces a newer one', async () => {
    const first = deferred<HistoryResult>();
    const history = vi.fn().mockImplementationOnce(() => first.promise).mockImplementation(async (from: number) => hist(from));
    const { el } = setup({ history });
    click(el, '[data-preset="week"]');
    await flush();
    expect(stats(el)[0]).toBe('7.00');
    first.resolve(hist(NOW - 86_400));
    await flush();
    expect(stats(el)[0]).toBe('7.00');
    expect(el.querySelector('.period-label')?.textContent).toBe('Останній тиждень');
    expect(el.querySelector('.chart-card')?.getAttribute('data-loading')).toBe('false');
  });

  it('errors keep the previous charts and offer a retry', async () => {
    const { api, el } = setup();
    await flush();
    api.history.mockRejectedValueOnce(new ApiError(0, 'network', "Немає зв'язку з хабом"));
    click(el, '[aria-label="Раніше"]');
    await flush();
    const error = el.querySelector('.inline-error') as HTMLElement;
    expect(error.hidden).toBe(false);
    expect(error.textContent).toContain("Немає зв'язку з хабом");
    expect(el.querySelectorAll('.chart-line')).toHaveLength(3);
    click(el, '.retry-btn');
    await flush();
    expect(error.hidden).toBe(true);
    expect(api.history).toHaveBeenLastCalledWith(NOW - 2 * 86_400, NOW - 86_400, CHART_METRICS, CHART_POINTS);
  });

  it('moves back in time and returns to the live window', async () => {
    const { el } = setup();
    await flush();
    const next = el.querySelector('[aria-label="Пізніше"]') as HTMLButtonElement;
    click(el, '[aria-label="Раніше"]');
    await flush();
    expect(el.querySelector('.period-label')?.textContent).toBe('4 жовт, 18:00 – 5 жовт, 18:00');
    expect(next.disabled).toBe(false);
    next.click();
    await flush();
    expect(el.querySelector('.period-label')?.textContent).toBe('Остання доба');
    expect(next.disabled).toBe(true);
  });

  it('shows whole custom days only when the dates make sense', async () => {
    const { api, el } = setup();
    await flush();
    click(el, '[data-preset="custom"]');
    const custom = el.querySelector('.custom-range') as HTMLElement;
    expect(custom.hidden).toBe(false);
    const [from, to] = [...custom.querySelectorAll('input')];
    expect([from.value, to.value]).toEqual(['2026-10-05', '2026-10-06']);
    const apply = custom.querySelector('.btn-small') as HTMLButtonElement;
    to.value = '2026-10-04';
    to.dispatchEvent(new Event('input'));
    expect(apply.disabled).toBe(true);
    to.value = '2026-10-05';
    to.dispatchEvent(new Event('input'));
    expect(apply.disabled).toBe(false);
    apply.click();
    await flush();
    const oct5 = Math.floor(new Date(2026, 9, 5).getTime() / 1000);
    expect(api.history).toHaveBeenLastCalledWith(oct5, oct5 + 86_400, CHART_METRICS, CHART_POINTS);
    expect(el.querySelector('.period-label')?.textContent).toBe('5 жовт');
  });

  it('says so when the period has no data, without NaN anywhere', async () => {
    const empty: HistoryResult = { table: 'samples_1h', bucketSec: 3600, ts: [], series: {} };
    const { el } = setup({ history: vi.fn(async () => empty), energy: vi.fn(async () => []), outages: vi.fn(async () => []) });
    await flush();
    expect([...el.querySelectorAll<HTMLElement>('.chart-empty')].every((e) => !e.hidden)).toBe(true);
    expect(el.innerHTML).not.toContain('NaN');
    expect(stats(el)).toEqual(['—', '—', 'немає']);
  });

  it('refreshes a live window every minute but leaves a past one alone', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const { api, el, page } = setup();
    await flush();
    vi.advanceTimersByTime(60_000);
    await flush();
    expect(api.history).toHaveBeenCalledTimes(2);
    click(el, '[aria-label="Раніше"]');
    await flush();
    vi.advanceTimersByTime(60_000);
    await flush();
    expect(api.history).toHaveBeenCalledTimes(3);
    page.destroy?.();
  });
});
