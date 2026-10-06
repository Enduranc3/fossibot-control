import { withQuery } from '../api.ts';
import type { UiDeps } from '../deps.ts';
import { DASH, dayHeader, fmtClock } from '../format.ts';
import type { HubInfo } from '../types.ts';
import { h, setText } from '../ui/dom.ts';

const KINDS: readonly [string, string][] = [
  ['energy', 'Енергія по годинах'],
  ['outages', 'Відключення'],
  ['events', 'Журнал подій'],
  ['samples', 'Заміри кожні 10 с'],
];
const PERIODS: readonly [string, string][] = [
  ['30', '30 днів'],
  ['365', 'Рік'],
];

const gb = (bytes: number) => {
  const v = bytes / 1e9;
  return v >= 10 ? `${Math.round(v)} ГБ` : `${v.toFixed(2)} ГБ`;
};

function select(label: string, options: readonly [string, string][]) {
  return h('select', { class: 'select', attrs: { 'aria-label': label } }, ...options.map(([v, t]) => h('option', { text: t, attrs: { value: v } })));
}

export function createHubInfo(deps: UiDeps, opts: { now?: () => number } = {}) {
  const now = opts.now ?? (() => Math.floor(Date.now() / 1000));
  const value = (name: string, label: string) => {
    const v = h('span', { class: 'num', text: DASH });
    return { v, el: h('div', { class: 'kv', attrs: { 'data-row': name } }, h('span', { text: label }), v) };
  };
  const memory = value('memory', "Пам'ять");
  const backup = value('backup', 'Резервна копія');
  const version = value('version', 'Версія');
  const kind = select('Що експортувати', KINDS);
  const period = select('За який час', PERIODS);
  const link = h('a', { class: 'btn-small', text: 'CSV', attrs: { 'data-action': 'export', download: '', href: '#' } });
  const exportRow = h('div', { class: 'kv export-row' }, h('span', { text: 'Експорт' }), h('span', { class: 'export-controls' }, kind, period, link));
  const el = h('div', { class: 'hub-info' }, memory.el, backup.el, version.el, exportRow);

  const syncLink = () => {
    // The hub serves 10-second samples for at most 31 days at a time.
    const samples = kind.value === 'samples';
    if (samples) period.value = '30';
    period.disabled = samples;
    const to = now();
    link.setAttribute('href', withQuery('/api/export.csv', { kind: kind.value, from: to - Number(period.value) * 86_400, to }));
  };
  kind.addEventListener('change', syncLink);
  period.addEventListener('change', syncLink);
  // The link holds the period's end, so it is refreshed just before it is followed.
  link.addEventListener('click', syncLink);
  syncLink();

  const render = (info: HubInfo) => {
    const n = now();
    setText(memory.v, `${gb(info.dbBytes)} з ${gb(info.budgetBytes)}`);
    const last = info.backup.last;
    setText(backup.v, last ? `${dayHeader(last.ts, n)}, ${fmtClock(last.ts)}` : info.backup.dir ? 'ще не було' : 'вимкнено');
    setText(version.v, info.version);
  };
  const refresh = () => deps.api.hubInfo().then(render, () => {});
  void refresh();
  return { el, refresh };
}
