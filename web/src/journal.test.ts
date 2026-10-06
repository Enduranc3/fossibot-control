// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from './api.ts';
import { TABS } from './app.ts';
import type { UiDeps } from './deps.ts';
import { describeEvent } from './events-text.ts';
import { createJournalPage } from './pages/journal.ts';
import { createAppStore } from './store.ts';
import type { EventPage, EventSource, EventType, HubEvent } from './types.ts';

afterEach(() => document.body.replaceChildren());

const at = (m: number, d: number, h = 0, min = 0) => Math.floor(new Date(2026, m - 1, d, h, min).getTime() / 1000);
const NOW = at(10, 6, 18);
const flush = () => new Promise((r) => setTimeout(r, 0));
const ev = (id: number, ts: number, type: EventType, data: Record<string, unknown> = {}, source: EventSource = 'hub'): HubEvent => ({ id, ts, type, source, data });

const PAGE1: EventPage = {
  events: [
    ev(5, at(10, 6, 17, 30), 'grid_lost', { soc: 84 }),
    ev(4, at(10, 6, 9), 'output_changed', { output: 'ac', from: 0, to: 1 }, 'app'),
    ev(3, at(10, 5, 22), 'grid_restored', { soc: 40 }),
    ev(2, at(10, 1, 8), 'setting_changed', { register: 'chargeLimit', from: 100, to: 90 }, 'station'),
  ],
  nextCursor: 2,
};
const PAGE2: EventPage = { events: [ev(1, at(9, 30, 8), 'hub_started')], nextCursor: null };

function deferred<T>() {
  let resolve: (v: T) => void = () => {};
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve: (v: T) => resolve(v) };
}

function setup(over: Record<string, unknown> = {}) {
  const api = {
    events: vi.fn(async (q: { cursor?: number } = {}) => (q.cursor ? PAGE2 : PAGE1)),
    ...over,
  };
  const store = createAppStore();
  const deps = { store, api, run: vi.fn(), confirm: vi.fn(), notify: vi.fn(), onLoggedOut: vi.fn() } as unknown as UiDeps;
  const page = createJournalPage(deps, { now: () => NOW });
  document.body.append(page.el);
  return { api, store, page, el: page.el };
}

const titles = (el: HTMLElement) => [...el.querySelectorAll('.section-title')].map((t) => t.textContent);
const rows = (el: HTMLElement) => [...el.querySelectorAll('.event-row')].map((r) => r.textContent ?? '');

describe('event texts', () => {
  it('describes every kind of event in plain Ukrainian', () => {
    expect(describeEvent(ev(1, 0, 'grid_lost', { soc: 84 }))).toEqual({ title: 'Зникло світло', detail: 'заряд 84%', tone: 'bad' });
    expect(describeEvent(ev(1, 0, 'grid_lost', { soc: null, initial: true }))).toEqual({ title: 'Світла немає', detail: 'на момент запуску хаба', tone: 'bad' });
    expect(describeEvent(ev(1, 0, 'grid_restored', { soc: 40 })).title).toBe('Світло повернулось');
    expect(describeEvent(ev(1, 0, 'output_changed', { output: 'led', from: 1, to: 0 }, 'station'))).toEqual({ title: 'Ліхтар вимкнено', detail: 'на станції', tone: 'none' });
    expect(describeEvent(ev(1, 0, 'setting_changed', { register: 'ecoMode', from: 0, to: 1 }, 'app'))).toEqual({ title: 'Режим роботи', detail: 'UPS → ECO · із застосунку', tone: 'none' });
    expect(describeEvent(ev(1, 0, 'setting_changed', { register: 'keySoundOff', from: 0, to: 1 }, 'station')).detail).toBe('увімк. → вимк. · на станції');
    expect(describeEvent(ev(1, 0, 'setting_changed', { register: 'acStandbyLegacy', from: 1, to: 2 }, 'station')).title).toBe('Налаштування acStandbyLegacy');
    expect(describeEvent(ev(1, 0, 'fault_set', { kind: 'bms', code: 4 }, 'station'))).toEqual({ title: 'Помилка BMS', detail: 'код 0x00000004', tone: 'bad' });
    expect(describeEvent(ev(1, 0, 'fault_cleared', { kind: 'pv', code: 4 }, 'station')).title).toBe('Помилку PV усунено');
    expect(describeEvent(ev(1, 0, 'soc_low', { soc: 19, threshold: 20 })).detail).toBe('19% · поріг 20%');
    expect(describeEvent(ev(1, 0, 'link_lost')).tone).toBe('warn');
    expect(describeEvent({ ...ev(1, 0, 'hub_started'), type: 'mystery' as EventType }).title).toBe('mystery');
  });
});

describe('journal page', () => {
  it('groups events by day, newest first', async () => {
    const { el } = setup();
    await flush();
    expect(titles(el)).toEqual(['Сьогодні', 'Вчора', '1 жовтня']);
    const list = rows(el);
    expect(list).toHaveLength(4);
    expect(list[0]).toContain('17:30');
    expect(list[0]).toContain('Зникло світло');
    expect(list[1]).toContain('AC увімкнено');
    expect(list[1]).toContain('із застосунку');
  });

  it('filters by type', async () => {
    const { api, el } = setup();
    await flush();
    (el.querySelector('[data-filter="grid"]') as HTMLButtonElement).click();
    await flush();
    expect(api.events).toHaveBeenLastCalledWith({ types: ['grid_lost', 'grid_restored'], cursor: undefined, limit: 50 });
    expect(el.querySelector('[data-filter="grid"]')?.getAttribute('aria-pressed')).toBe('true');
    expect(el.querySelector('[data-filter="all"]')?.getAttribute('aria-pressed')).toBe('false');
  });

  it('loads older events with the cursor and hides the button at the end', async () => {
    const { api, el } = setup();
    await flush();
    const more = el.querySelector('.more-btn') as HTMLButtonElement;
    expect(more.hidden).toBe(false);
    more.click();
    await flush();
    expect(api.events).toHaveBeenLastCalledWith({ types: [], cursor: 2, limit: 50 });
    expect(rows(el)).toHaveLength(5);
    expect(titles(el)).toContain('30 вересня');
    expect(more.hidden).toBe(true);
  });

  it('prepends live events that match the filter, once', async () => {
    const { el, store } = setup();
    await flush();
    const live = ev(6, NOW - 60, 'grid_restored', { soc: 85 });
    store.set({ lastEvent: live });
    expect(rows(el)[0]).toContain('Світло повернулось');
    store.set({ lastEvent: { ...live } });
    expect(rows(el)).toHaveLength(5);
    (el.querySelector('[data-filter="outputs"]') as HTMLButtonElement).click();
    await flush();
    const before = rows(el).length;
    store.set({ lastEvent: ev(7, NOW - 30, 'grid_lost', { soc: 85 }) });
    expect(rows(el)).toHaveLength(before);
  });

  it('a slow earlier answer never replaces a newer one', async () => {
    const first = deferred<EventPage>();
    const events = vi
      .fn()
      .mockImplementationOnce(() => first.promise)
      .mockImplementation(async () => ({ events: [ev(8, NOW - 100, 'output_changed', { output: 'dc', to: 1 }, 'app')], nextCursor: null }));
    const { el } = setup({ events });
    (el.querySelector('[data-filter="outputs"]') as HTMLButtonElement).click();
    await flush();
    first.resolve(PAGE1);
    await flush();
    expect(rows(el)).toHaveLength(1);
    expect(rows(el)[0]).toContain('DC увімкнено');
  });

  it('errors keep the list and offer a retry; an empty journal says so', async () => {
    const { api, el } = setup();
    await flush();
    api.events.mockRejectedValueOnce(new ApiError(0, 'network', "Немає зв'язку з хабом"));
    (el.querySelector('[data-filter="faults"]') as HTMLButtonElement).click();
    await flush();
    expect((el.querySelector('.inline-error') as HTMLElement).hidden).toBe(false);
    expect(rows(el)).toHaveLength(4);
    api.events.mockResolvedValueOnce({ events: [], nextCursor: null });
    (el.querySelector('.retry-btn') as HTMLButtonElement).click();
    await flush();
    expect((el.querySelector('.inline-error') as HTMLElement).hidden).toBe(true);
    expect((el.querySelector('.empty-note') as HTMLElement).hidden).toBe(false);
  });
});

describe('navigation', () => {
  it('has five tabs in reading order', () => {
    expect(TABS.map((t) => t.path)).toEqual(['/', '/charts', '/outages', '/journal', '/settings']);
  });
});
