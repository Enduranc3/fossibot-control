import { ApiError } from '../api.ts';
import type { UiDeps } from '../deps.ts';
import { EVENT_FILTERS, describeEvent, type EventFilter } from '../events-text.ts';
import { dateValue, dayHeader, fmtClock } from '../format.ts';
import type { Page } from '../router.ts';
import type { HubEvent } from '../types.ts';
import { h, setText } from '../ui/dom.ts';

const PAGE_SIZE = 50;

function eventRow(e: HubEvent): HTMLElement {
  const t = describeEvent(e);
  return h(
    'div',
    { class: 'event-row', attrs: { 'data-type': e.type } },
    h('span', { class: 'event-time num', text: fmtClock(e.ts) }),
    h('span', { class: 'dot', attrs: { 'data-state': t.tone } }),
    h('div', { class: 'event-text' }, h('div', { class: 'event-title', text: t.title }), t.detail ? h('div', { class: 'event-detail', text: t.detail }) : null),
  );
}

export function createJournalPage(deps: UiDeps, opts: { now?: () => number } = {}): Page {
  const now = opts.now ?? (() => Math.floor(Date.now() / 1000));
  let filter: EventFilter = EVENT_FILTERS[0];
  let events: HubEvent[] = [];
  let cursor: number | null = null;
  let seq = 0;

  const chips = EVENT_FILTERS.map((f) => {
    const b = h('button', { class: 'chip', text: f.label, attrs: { type: 'button', 'aria-pressed': String(f === filter), 'data-filter': f.id } });
    b.addEventListener('click', () => pick(f));
    return b;
  });
  const list = h('div', { class: 'journal-list' });
  const empty = h('p', { class: 'empty-note', text: 'Подій ще немає' });
  empty.hidden = true;
  const more = h('button', { class: 'more-btn', text: 'Показати ще', attrs: { type: 'button' } });
  more.hidden = true;
  const errorText = h('span');
  const retry = h('button', { class: 'retry-btn', text: 'Повторити', attrs: { type: 'button' } });
  const error = h('div', { class: 'inline-error', attrs: { role: 'alert' } }, errorText, retry);
  error.hidden = true;
  const el = h(
    'div',
    { class: 'journal', attrs: { 'data-loading': 'false' } },
    h('div', { class: 'chips', attrs: { role: 'group', 'aria-label': 'Тип подій' } }, ...chips),
    error,
    list,
    empty,
    more,
  );

  function render() {
    const n = now();
    const nodes: HTMLElement[] = [];
    let day = '';
    let card = h('div', { class: 'card list' });
    for (const e of events) {
      const key = dateValue(e.ts);
      if (key !== day) {
        day = key;
        card = h('div', { class: 'card list' });
        nodes.push(h('div', { class: 'section-title', text: dayHeader(e.ts, n) }), card);
      }
      card.append(eventRow(e));
    }
    list.replaceChildren(...nodes);
    empty.hidden = events.length > 0;
    more.hidden = cursor === null;
  }

  async function load(append = false) {
    const my = ++seq;
    el.dataset.loading = 'true';
    more.disabled = true;
    try {
      const page = await deps.api.events({ types: filter.types, cursor: append ? (cursor ?? undefined) : undefined, limit: PAGE_SIZE });
      if (my !== seq) return;
      if (append) {
        const seen = new Set(events.map((e) => e.id));
        events = [...events, ...page.events.filter((e) => !seen.has(e.id))];
      } else {
        events = page.events;
      }
      cursor = page.nextCursor;
      render();
      error.hidden = true;
    } catch (err) {
      if (my !== seq) return;
      setText(errorText, err instanceof ApiError ? err.message : 'Не вдалося завантажити події');
      error.hidden = false;
    } finally {
      if (my === seq) {
        el.dataset.loading = 'false';
        more.disabled = false;
      }
    }
  }

  function pick(f: EventFilter) {
    filter = f;
    for (const b of chips) b.setAttribute('aria-pressed', String(b.dataset.filter === f.id));
    void load();
  }

  more.addEventListener('click', () => void load(true));
  retry.addEventListener('click', () => void load());
  const unsubscribe = deps.store.subscribe((st, before) => {
    const e = st.lastEvent;
    if (!e || e === before.lastEvent) return;
    if (filter.types.length && !filter.types.includes(e.type)) return;
    if (e.id !== undefined && events.some((x) => x.id === e.id)) return;
    events = [e, ...events];
    render();
  });
  void load();

  return {
    el,
    destroy() {
      seq++;
      unsubscribe();
    },
  };
}
