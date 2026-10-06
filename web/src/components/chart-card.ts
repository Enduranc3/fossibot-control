import { h, setText } from '../ui/dom.ts';

export interface LegendItem {
  label: string;
  color: string;
  mark: 'line' | 'bar' | 'band';
}

export interface ChartCard {
  el: HTMLElement;
  plot: HTMLElement;
  setLoading(on: boolean): void;
  setEmpty(on: boolean): void;
  /** Rows of the table view; the table itself is built only while it is shown. */
  setTable(header: readonly string[], rows: readonly (readonly string[])[]): void;
}

/** Colour key: a short line, a column or a band swatch. The colour never goes on text. */
export function legendKey(color: string, mark: LegendItem['mark']): HTMLElement {
  const key = h('span', { class: `legend-key legend-${mark}` });
  key.style.setProperty('--key', color);
  return key;
}

export function createChartCard(o: { title: string; legend?: readonly LegendItem[] }): ChartCard {
  const plot = h('div', { class: 'chart-plot' });
  const empty = h('div', { class: 'chart-empty', text: 'Немає даних за цей період' });
  empty.hidden = true;
  const body = h('div', { class: 'chart-body' }, plot, empty);
  const table = h('div', { class: 'chart-table' });
  table.hidden = true;
  const toggle = h('button', { class: 'chart-toggle', text: 'Таблиця', attrs: { type: 'button', 'aria-pressed': 'false' } });
  const legend = o.legend?.length
    ? h('div', { class: 'chart-legend' }, ...o.legend.map((i) => h('span', { class: 'legend-item' }, legendKey(i.color, i.mark), i.label)))
    : null;
  const el = h(
    'section',
    { class: 'chart-card card', attrs: { 'aria-label': o.title, 'data-loading': 'false' } },
    h('div', { class: 'chart-head' }, h('h2', { class: 'chart-title', text: o.title }), toggle),
    legend,
    body,
    table,
  );
  let header: readonly string[] = [];
  let rows: readonly (readonly string[])[] = [];
  const showingTable = () => toggle.getAttribute('aria-pressed') === 'true';
  const buildTable = () => {
    if (!rows.length) {
      table.replaceChildren(h('p', { class: 'chart-table-empty', text: 'Немає даних' }));
      return;
    }
    table.replaceChildren(
      h(
        'table',
        {},
        h('thead', {}, h('tr', {}, ...header.map((c) => h('th', { text: c })))),
        h('tbody', {}, ...rows.map((r) => h('tr', {}, ...r.map((c) => h('td', { class: 'num', text: c }))))),
      ),
    );
  };
  toggle.addEventListener('click', () => {
    const show = !showingTable();
    toggle.setAttribute('aria-pressed', String(show));
    setText(toggle, show ? 'Графік' : 'Таблиця');
    body.hidden = show;
    if (legend) legend.hidden = show;
    table.hidden = !show;
    if (show) buildTable();
  });
  return {
    el,
    plot,
    setLoading(on) {
      el.dataset.loading = String(on);
    },
    setEmpty(on) {
      empty.hidden = !on;
    },
    setTable(nextHeader, nextRows) {
      header = nextHeader;
      rows = nextRows;
      if (showingTable()) buildTable();
    },
  };
}
