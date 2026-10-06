import { ApiError } from '../api.ts';
import { COLORS } from '../charts/colors.ts';
import { clipIntervals } from '../charts/path.ts';
import { createChartCard } from '../components/chart-card.ts';
import { createEnergyChart, energyTable } from '../components/energy-chart.ts';
import { createLineChart, lineTable, type LineData } from '../components/line-chart.ts';
import type { UiDeps } from '../deps.ts';
import { DASH, dateValue, fmtDuration, fmtKwh } from '../format.ts';
import { PRESETS, customPeriod, energyBucket, isLive, periodLabel, presetPeriod, shiftPeriod, type Period, type Preset } from '../period.ts';
import type { Page } from '../router.ts';
import type { EnergyRow, HistoryResult, Outage } from '../types.ts';
import { h, setText } from '../ui/dom.ts';

export const CHART_METRICS = ['soc', 'in_w', 'out_w', 'ac_in_w', 'solar_w'] as const;
export const CHART_POINTS = 400;
const REFRESH_MS = 60_000;

const watts = (v: number) => `${Math.round(v)} W`;
const percent = (v: number) => `${Math.round(v)}%`;

function stat(label: string) {
  const v = h('div', { class: 'stat-v num', text: DASH });
  return { v, el: h('div', { class: 'stat' }, v, h('div', { class: 'stat-l', text: label })) };
}

export function createChartsPage(deps: UiDeps, opts: { now?: () => number } = {}): Page {
  const now = opts.now ?? (() => Math.floor(Date.now() / 1000));
  let period: Period = presetPeriod('day', now());
  /** The window follows the clock until the user moves it back or picks dates. */
  let following = true;
  let customOpen = false;
  let seq = 0;

  const presetButtons = PRESETS.map((p) => {
    const b = h('button', { text: p.label, attrs: { type: 'button', 'aria-pressed': 'false', 'data-preset': p.id } });
    b.addEventListener('click', () => pickPreset(p.id));
    return b;
  });
  const prev = h('button', { class: 'icon-btn', text: '‹', attrs: { type: 'button', 'aria-label': 'Раніше' } });
  const next = h('button', { class: 'icon-btn', text: '›', attrs: { type: 'button', 'aria-label': 'Пізніше' } });
  const label = h('div', { class: 'period-label' });
  const fromInput = h('input', { class: 'date-input', attrs: { type: 'date', 'aria-label': 'Від' } });
  const toInput = h('input', { class: 'date-input', attrs: { type: 'date', 'aria-label': 'До' } });
  const apply = h('button', { class: 'btn-small', text: 'Показати', attrs: { type: 'button' } });
  const custom = h('div', { class: 'custom-range' }, fromInput, h('span', { class: 'custom-dash', text: '–' }), toInput, apply);
  const errorText = h('span');
  const retry = h('button', { class: 'retry-btn', text: 'Повторити', attrs: { type: 'button' } });
  const error = h('div', { class: 'inline-error', attrs: { role: 'alert' } }, errorText, retry);
  error.hidden = true;
  const got = stat('Отримано, кВт·год');
  const used = stat('Спожито, кВт·год');
  const dark = stat('Без світла');

  const soc = createLineChart({ label: 'Заряд батареї', yMin: 0, yMax: 100, yTicks: [0, 50, 100], format: percent });
  const power = createLineChart({ label: 'Потужність', yMin: 0, format: watts, axisFormat: (v) => String(v) });
  const energy = createEnergyChart();
  const outageKey = { label: 'Відключення', color: COLORS.outage, mark: 'band' } as const;
  const socCard = createChartCard({ title: 'Заряд батареї, %', legend: [outageKey] });
  const powerCard = createChartCard({
    title: 'Потужність, W',
    legend: [{ label: 'Вхід', color: COLORS.in, mark: 'line' }, { label: 'Вихід', color: COLORS.out, mark: 'line' }, outageKey],
  });
  const energyCard = createChartCard({
    title: 'Енергія, кВт·год',
    legend: [
      { label: 'Отримано', color: COLORS.in, mark: 'bar' },
      { label: 'Спожито', color: COLORS.out, mark: 'bar' },
    ],
  });
  socCard.plot.append(soc.el);
  powerCard.plot.append(power.el);
  energyCard.plot.append(energy.el);
  const cards = [socCard, powerCard, energyCard];

  const el = h(
    'div',
    { class: 'charts' },
    h('div', { class: 'segmented period-presets', attrs: { role: 'group', 'aria-label': 'Період' } }, ...presetButtons),
    h('div', { class: 'period-nav' }, prev, label, next),
    custom,
    error,
    h('section', { class: 'period-stats card' }, got.el, used.el, dark.el),
    socCard.el,
    powerCard.el,
    energyCard.el,
  );

  function syncControls() {
    const pressed: Preset = customOpen ? 'custom' : period.preset;
    for (const b of presetButtons) b.setAttribute('aria-pressed', String(b.dataset.preset === pressed));
    setText(label, periodLabel(period, now()));
    next.disabled = following || period.to >= now();
    custom.hidden = !customOpen;
    apply.disabled = !customPeriod(fromInput.value, toInput.value);
  }

  function render(p: Period, hist: HistoryResult, rows: EnergyRow[], outages: Outage[]) {
    const bands = clipIntervals(outages, p.from, p.to, now());
    const avg = (m: string) => hist.series[m]?.avg ?? [];
    const base = { from: p.from, to: p.to, ts: hist.ts, bucketSec: hist.bucketSec, bands };
    const socData: LineData = { ...base, series: [{ key: 'soc', label: 'Заряд', color: COLORS.soc, values: avg('soc'), area: true }] };
    const grid = avg('ac_in_w');
    const solar = avg('solar_w');
    const powerData: LineData = {
      ...base,
      series: [
        { key: 'in', label: 'Вхід', color: COLORS.in, values: avg('in_w') },
        { key: 'out', label: 'Вихід', color: COLORS.out, values: avg('out_w') },
      ],
      // With solar present the tooltip also says where the input came from.
      extra: (i) => {
        const sun = solar[i];
        const g = grid[i];
        return sun ? [['з мережі', g === null || g === undefined ? DASH : watts(g)], ['від сонця', watts(sun)]] : [];
      },
    };
    const energyData = { rows, bucket: energyBucket(p.to - p.from) };
    soc.update(socData);
    power.update(powerData);
    energy.update(energyData);
    const noSamples = hist.ts.length === 0;
    socCard.setEmpty(noSamples);
    powerCard.setEmpty(noSamples);
    energyCard.setEmpty(rows.length === 0);
    const socTable = lineTable(socData, percent);
    socCard.setTable(socTable.header, socTable.rows);
    const powerTable = lineTable(powerData, watts);
    powerCard.setTable(powerTable.header, powerTable.rows);
    const eTable = energyTable(energyData);
    energyCard.setTable(eTable.header, eTable.rows);
    const sum = (f: (r: EnergyRow) => number) => rows.reduce((a, r) => a + f(r), 0);
    setText(got.v, rows.length ? fmtKwh(sum((r) => r.gridInWh + r.solarInWh)) : DASH);
    setText(used.v, rows.length ? fmtKwh(sum((r) => r.outWh)) : DASH);
    const darkSec = bands.reduce((a, [x0, x1]) => a + x1 - x0, 0);
    setText(dark.v, darkSec > 0 ? fmtDuration(darkSec) : 'немає');
  }

  async function load() {
    const my = ++seq;
    const p = period;
    syncControls();
    for (const c of cards) c.setLoading(true);
    try {
      const [hist, rows, outages] = await Promise.all([
        deps.api.history(p.from, p.to, CHART_METRICS, CHART_POINTS),
        deps.api.energy(Math.floor(p.from / 3600) * 3600, p.to, energyBucket(p.to - p.from)),
        deps.api.outages(p.from, p.to),
      ]);
      if (my !== seq) return;
      render(p, hist, rows, outages);
      error.hidden = true;
    } catch (err) {
      if (my !== seq) return;
      setText(errorText, err instanceof ApiError ? err.message : 'Не вдалося завантажити дані');
      error.hidden = false;
    } finally {
      if (my === seq) for (const c of cards) c.setLoading(false);
    }
  }

  function pickPreset(id: Preset) {
    if (id === 'custom') {
      customOpen = true;
      fromInput.value = dateValue(period.from);
      toInput.value = dateValue(period.to - 1);
      syncControls();
      return;
    }
    customOpen = false;
    following = true;
    period = presetPeriod(id, now());
    void load();
  }

  prev.addEventListener('click', () => {
    following = false;
    period = shiftPeriod(period, -1, now());
    void load();
  });
  next.addEventListener('click', () => {
    period = shiftPeriod(period, 1, now());
    following = period.preset !== 'custom' && isLive(period, now());
    void load();
  });
  const onDates = () => {
    apply.disabled = !customPeriod(fromInput.value, toInput.value);
  };
  for (const input of [fromInput, toInput]) {
    input.addEventListener('input', onDates);
    input.addEventListener('change', onDates);
  }
  apply.addEventListener('click', () => {
    const p = customPeriod(fromInput.value, toInput.value);
    if (!p) return;
    period = p;
    following = false;
    void load();
  });
  retry.addEventListener('click', () => void load());

  const refresh = () => {
    if (!following || period.preset === 'custom') return;
    period = presetPeriod(period.preset, now());
    void load();
  };
  const timer = setInterval(refresh, REFRESH_MS);
  const onVisible = () => {
    if (document.visibilityState === 'visible') refresh();
  };
  document.addEventListener('visibilitychange', onVisible);
  void load();

  return {
    el,
    destroy() {
      seq++;
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
      soc.destroy();
      power.destroy();
      energy.destroy();
    },
  };
}
