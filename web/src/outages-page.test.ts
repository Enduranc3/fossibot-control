// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from './api.ts';
import type { UiDeps } from './deps.ts';
import { createOutagesPage, heatLevel } from './pages/outages.ts';
import { createAppStore } from './store.ts';
import type { Outage, OutageCalendar } from './types.ts';

afterEach(() => document.body.replaceChildren());

const at = (m: number, d: number, h = 0, min = 0) => Math.floor(new Date(2026, m - 1, d, h, min).getTime() / 1000);
const NOW = at(10, 6, 18);
const flush = () => new Promise((r) => setTimeout(r, 0));

function calFor(month: string): OutageCalendar {
  const [y, m] = month.split('-').map(Number);
  const n = new Date(y, m, 0).getDate();
  const oct = month === '2026-10';
  return {
    days: Array.from({ length: n }, (_, i) => ({
      date: `${month}-${String(i + 1).padStart(2, '0')}`,
      outageSec: oct ? ([0, 0, 7200, 0, 46_800, 1800][i] ?? 0) : 0,
    })),
    count: oct ? 3 : 0,
    totalSec: oct ? 55_800 : 0,
    longestSec: oct ? 46_800 : 0,
  };
}
const OUTAGES: Outage[] = [
  { id: 3, startTs: at(10, 6, 17, 30), endTs: null, socStart: 84, socEnd: null, outWh: 50 },
  { id: 2, startTs: at(10, 5, 6), endTs: at(10, 5, 19), socStart: 90, socEnd: 22, outWh: 1900 },
  { id: 1, startTs: at(10, 3, 10), endTs: at(10, 3, 12), socStart: 80, socEnd: 60, outWh: 300 },
];

function deferred<T>() {
  let resolve: (v: T) => void = () => {};
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve: (v: T) => resolve(v) };
}

function setup(over: Record<string, unknown> = {}) {
  const api = {
    calendar: vi.fn(async (m: string) => calFor(m)),
    outages: vi.fn(async (from: number) => (from === at(10, 1) ? OUTAGES : [])),
    ...over,
  };
  const store = createAppStore();
  const deps = { store, api, run: vi.fn(), confirm: vi.fn(), notify: vi.fn(), onLoggedOut: vi.fn() } as unknown as UiDeps;
  const page = createOutagesPage(deps, { now: () => NOW });
  document.body.append(page.el);
  return { api, store, page, el: page.el };
}

const day = (el: HTMLElement, date: string) => el.querySelector(`[data-date="${date}"]`) as HTMLButtonElement;
const rows = (el: HTMLElement) => [...el.querySelectorAll('.outage-row')].map((r) => r.textContent ?? '');

describe('heat levels', () => {
  it('bins hours without power', () => {
    expect([0, 1, 3600, 3601, 3 * 3600, 6 * 3600, 12 * 3600, 12 * 3600 + 1].map(heatLevel)).toEqual([0, 1, 1, 2, 2, 3, 4, 5]);
  });
});

describe('outages page', () => {
  it('lays out the month from Monday and colours days by hours without power', async () => {
    const { el } = setup();
    await flush();
    expect(el.querySelector('.month-title')?.textContent).toBe('Жовтень 2026');
    expect(el.querySelectorAll('.cal-pad')).toHaveLength(3); // 1 October 2026 is a Thursday
    expect(el.querySelectorAll('.cal-day')).toHaveLength(31);
    expect(day(el, '2026-10-03').dataset.level).toBe('2');
    expect(day(el, '2026-10-05').dataset.level).toBe('5');
    expect(day(el, '2026-10-06').dataset.level).toBe('1');
    expect(day(el, '2026-10-06').dataset.today).toBe('true');
    expect(day(el, '2026-10-07').disabled).toBe(true);
    expect(day(el, '2026-10-05').getAttribute('aria-label')).toBe('5 жовтня: без світла 13 год 00 хв');
    expect([...el.querySelectorAll('.outage-stats .stat-v')].map((s) => s.textContent)).toEqual(['3', '15 год 30 хв', '13 год 00 хв']);
  });

  it('lists outages with the ongoing one first', async () => {
    const { el } = setup();
    await flush();
    const list = rows(el);
    expect(list).toHaveLength(3);
    expect(list[0]).toContain('17:30 – зараз');
    expect(list[0]).toContain('триває');
    expect(list[0]).toContain('30 хв');
    expect(list[0]).toContain('з 84%');
    expect(list[1]).toContain('06:00 – 19:00');
    expect(list[1]).toContain('90 → 22%');
    expect(list[1]).toContain('1.90 кВт·год');
    expect(el.querySelector('[data-ongoing="true"]')).not.toBeNull();
  });

  it('filters the list by a tapped day and shows all again on a second tap', async () => {
    const { el } = setup();
    await flush();
    day(el, '2026-10-05').click();
    expect(rows(el)).toHaveLength(1);
    expect(el.querySelector('.list-title')?.textContent).toBe('5 жовтня');
    expect(day(el, '2026-10-05').getAttribute('aria-pressed')).toBe('true');
    day(el, '2026-10-05').click();
    expect(rows(el)).toHaveLength(3);
    expect(el.querySelector('.list-title')?.textContent).toBe('Усі відключення місяця');
  });

  it('walks to earlier months but not into the future', async () => {
    const { api, el } = setup();
    await flush();
    const [prev, next] = [...el.querySelectorAll<HTMLButtonElement>('.month-nav .icon-btn')];
    expect(next.disabled).toBe(true);
    prev.click();
    await flush();
    expect(api.calendar).toHaveBeenLastCalledWith('2026-09');
    expect(api.outages).toHaveBeenLastCalledWith(at(9, 1), at(10, 1));
    expect(el.querySelector('.month-title')?.textContent).toBe('Вересень 2026');
    expect(next.disabled).toBe(false);
    expect(el.querySelector('.empty-note')?.textContent).toBe('Відключень не було');
  });

  it('a slow earlier answer never replaces a newer one', async () => {
    const first = deferred<OutageCalendar>();
    const calendar = vi.fn().mockImplementationOnce(() => first.promise).mockImplementation(async (m: string) => calFor(m));
    const { el } = setup({ calendar });
    (el.querySelector('.month-nav .icon-btn') as HTMLButtonElement).click();
    await flush();
    first.resolve(calFor('2026-10'));
    await flush();
    expect(el.querySelector('.month-title')?.textContent).toBe('Вересень 2026');
    expect(el.querySelectorAll('.cal-day')).toHaveLength(30);
  });

  it('errors keep the previous month and offer a retry', async () => {
    const { api, el } = setup();
    await flush();
    api.calendar.mockRejectedValueOnce(new ApiError(0, 'network', "Немає зв'язку з хабом"));
    (el.querySelector('.month-nav .icon-btn') as HTMLButtonElement).click();
    await flush();
    const error = el.querySelector('.inline-error') as HTMLElement;
    expect(error.hidden).toBe(false);
    expect(el.querySelectorAll('.cal-day')).toHaveLength(31);
    (el.querySelector('.retry-btn') as HTMLButtonElement).click();
    await flush();
    expect(error.hidden).toBe(true);
    expect(el.querySelectorAll('.cal-day')).toHaveLength(30);
  });

  it('reloads the current month when the grid goes or comes back', async () => {
    const { api, store } = setup();
    await flush();
    store.set({ lastEvent: { id: 9, ts: NOW, type: 'grid_restored', source: 'hub', data: {} } });
    await flush();
    expect(api.calendar).toHaveBeenCalledTimes(2);
    store.set({ lastEvent: { id: 10, ts: NOW, type: 'output_changed', source: 'app', data: {} } });
    await flush();
    expect(api.calendar).toHaveBeenCalledTimes(2);
  });
});
