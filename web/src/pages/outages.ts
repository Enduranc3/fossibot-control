import { ApiError } from '../api.ts';
import type { UiDeps } from '../deps.ts';
import { DASH, dateValue, fmtClock, fmtDateTime, fmtDay, fmtDuration, fmtKwh, fmtWeekdayDay } from '../format.ts';
import { dateStart, monthKey, monthLabel, monthRange, shiftMonth } from '../period.ts';
import type { Page } from '../router.ts';
import type { Outage, OutageCalendar } from '../types.ts';
import { h, setText } from '../ui/dom.ts';

/** 0 = no outage; 1–5 = up to 1, 3, 6, 12 and over 12 hours without power that day. */
export function heatLevel(sec: number): number {
  if (sec <= 0) return 0;
  if (sec <= 3600) return 1;
  if (sec <= 3 * 3600) return 2;
  if (sec <= 6 * 3600) return 3;
  if (sec <= 12 * 3600) return 4;
  return 5;
}

const HEAT_LEGEND = ['0', '≤1', '1–3', '3–6', '6–12', '12+'];
const WEEK = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Нд'];

function stat(label: string) {
  const v = h('div', { class: 'stat-v num', text: DASH });
  return { v, el: h('div', { class: 'stat' }, v, h('div', { class: 'stat-l', text: label })) };
}

function outageRow(o: Outage, nowSec: number): HTMLElement {
  const end = o.endTs;
  const until = end === null ? 'зараз' : dateValue(end) === dateValue(o.startTs) ? fmtClock(end) : fmtDateTime(end);
  const soc = o.socStart !== null && o.socEnd !== null ? `${o.socStart} → ${o.socEnd}%` : o.socStart !== null ? `з ${o.socStart}%` : '';
  const meta = [soc, o.outWh > 0 ? `${fmtKwh(o.outWh)} кВт·год` : ''].filter(Boolean).join(' · ');
  return h(
    'div',
    { class: 'outage-row', attrs: end === null ? { 'data-ongoing': 'true' } : {} },
    h(
      'div',
      { class: 'outage-main' },
      h('div', { class: 'outage-date', text: fmtWeekdayDay(o.startTs) }),
      h('div', { class: 'outage-time num', text: `${fmtClock(o.startTs)} – ${until}` }),
      end === null ? h('div', { class: 'badge-live' }, h('span', { class: 'dot', attrs: { 'data-state': 'bad' } }), 'триває') : null,
    ),
    h(
      'div',
      { class: 'outage-side' },
      h('div', { class: 'outage-dur num', text: fmtDuration((end ?? nowSec) - o.startTs) }),
      meta ? h('div', { class: 'outage-meta', text: meta }) : null,
    ),
  );
}

export function createOutagesPage(deps: UiDeps, opts: { now?: () => number } = {}): Page {
  const now = opts.now ?? (() => Math.floor(Date.now() / 1000));
  let month = monthKey(now());
  let selected: string | null = null;
  let outages: Outage[] = [];
  let seq = 0;

  const prev = h('button', { class: 'icon-btn', text: '‹', attrs: { type: 'button', 'aria-label': 'Попередній місяць' } });
  const next = h('button', { class: 'icon-btn', text: '›', attrs: { type: 'button', 'aria-label': 'Наступний місяць' } });
  const title = h('h2', { class: 'month-title' });
  const count = stat('Відключень');
  const total = stat('Без світла');
  const longest = stat('Найдовше');
  const days = h('div', { class: 'cal-grid' });
  const calendar = h(
    'section',
    { class: 'calendar card', attrs: { 'aria-label': 'Календар відключень' } },
    h('div', { class: 'cal-week' }, ...WEEK.map((d) => h('span', { text: d }))),
    days,
    h(
      'div',
      { class: 'heat-legend' },
      h('span', { class: 'heat-title', text: 'Годин без світла за день' }),
      ...HEAT_LEGEND.map((t, i) => h('span', { class: 'heat-step' }, h('span', { class: 'heat-swatch', attrs: { 'data-level': String(i) } }), t)),
    ),
  );
  const listTitle = h('span', { class: 'list-title' });
  const showAll = h('button', { class: 'show-all', text: 'Показати всі', attrs: { type: 'button' } });
  showAll.hidden = true;
  const list = h('div', { class: 'card list outage-list' });
  const errorText = h('span');
  const retry = h('button', { class: 'retry-btn', text: 'Повторити', attrs: { type: 'button' } });
  const error = h('div', { class: 'inline-error', attrs: { role: 'alert' } }, errorText, retry);
  error.hidden = true;
  const el = h(
    'div',
    { class: 'outages', attrs: { 'data-loading': 'false' } },
    h('div', { class: 'month-nav' }, prev, title, next),
    error,
    h('section', { class: 'outage-stats card' }, count.el, total.el, longest.el),
    calendar,
    h('div', { class: 'section-title list-head' }, listTitle, showAll),
    list,
  );

  function syncHeader() {
    setText(title, monthLabel(month));
    next.disabled = month >= monthKey(now());
  }

  function renderStats(cal: OutageCalendar) {
    setText(count.v, String(cal.count));
    setText(total.v, cal.totalSec > 0 ? fmtDuration(cal.totalSec) : 'немає');
    setText(longest.v, cal.longestSec > 0 ? fmtDuration(cal.longestSec) : DASH);
  }

  function renderCalendar(cal: OutageCalendar) {
    const [y, m] = month.split('-').map(Number);
    const offset = (new Date(y, m - 1, 1).getDay() + 6) % 7;
    const today = dateValue(now());
    const cells = cal.days.map((d) => {
      const b = h('button', {
        class: 'cal-day',
        text: String(Number(d.date.slice(8))),
        attrs: {
          type: 'button',
          'data-date': d.date,
          'data-level': String(heatLevel(d.outageSec)),
          'aria-pressed': String(selected === d.date),
          'aria-label': `${fmtDay(dateStart(d.date) ?? 0)}: ${d.outageSec > 0 ? `без світла ${fmtDuration(d.outageSec)}` : 'без відключень'}`,
        },
      });
      if (d.date === today) b.dataset.today = 'true';
      if (d.date > today) b.disabled = true;
      b.addEventListener('click', () => {
        selected = selected === d.date ? null : d.date;
        syncSelection();
      });
      return b;
    });
    days.replaceChildren(...Array.from({ length: offset }, () => h('span', { class: 'cal-pad' })), ...cells);
  }

  function renderList() {
    const n = now();
    let shown = outages;
    if (selected) {
      const from = dateStart(selected) ?? 0;
      // The next local midnight, robust to 23- and 25-hour days.
      const to = dateStart(dateValue(from + 36 * 3600)) ?? from + 86_400;
      shown = outages.filter((o) => o.startTs < to && (o.endTs ?? n) > from);
    }
    setText(listTitle, selected ? fmtDay(dateStart(selected) ?? 0) : 'Усі відключення місяця');
    showAll.hidden = !selected;
    list.replaceChildren(
      ...(shown.length
        ? shown.map((o) => outageRow(o, n))
        : [h('p', { class: 'empty-note', text: selected ? 'Цього дня світло було' : 'Відключень не було' })]),
    );
  }

  function syncSelection() {
    for (const b of days.querySelectorAll<HTMLButtonElement>('.cal-day')) b.setAttribute('aria-pressed', String(b.dataset.date === selected));
    renderList();
  }

  async function load() {
    const my = ++seq;
    const key = month;
    syncHeader();
    el.dataset.loading = 'true';
    try {
      const { from, to } = monthRange(key);
      const [cal, monthOutages] = await Promise.all([deps.api.calendar(key), deps.api.outages(from, to)]);
      if (my !== seq) return;
      outages = monthOutages;
      renderStats(cal);
      renderCalendar(cal);
      renderList();
      error.hidden = true;
    } catch (err) {
      if (my !== seq) return;
      setText(errorText, err instanceof ApiError ? err.message : 'Не вдалося завантажити дані');
      error.hidden = false;
    } finally {
      if (my === seq) el.dataset.loading = 'false';
    }
  }

  prev.addEventListener('click', () => {
    month = shiftMonth(month, -1);
    selected = null;
    void load();
  });
  next.addEventListener('click', () => {
    if (month >= monthKey(now())) return;
    month = shiftMonth(month, 1);
    selected = null;
    void load();
  });
  showAll.addEventListener('click', () => {
    selected = null;
    syncSelection();
  });
  retry.addEventListener('click', () => void load());
  const unsubscribe = deps.store.subscribe((st, before) => {
    const e = st.lastEvent;
    if (!e || e === before.lastEvent || month !== monthKey(now())) return;
    if (e.type === 'grid_lost' || e.type === 'grid_restored') void load();
  });
  // An ongoing outage keeps growing; refresh its duration once a minute.
  const tick = setInterval(() => {
    if (outages.some((o) => o.endTs === null)) renderList();
  }, 60_000);
  void load();

  return {
    el,
    destroy() {
      seq++;
      unsubscribe();
      clearInterval(tick);
    },
  };
}
