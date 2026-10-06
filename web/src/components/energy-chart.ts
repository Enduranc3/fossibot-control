import { COLORS } from '../charts/colors.ts';
import { barPath, r1 } from '../charts/path.ts';
import { linear, niceTicks } from '../charts/scale.ts';
import { MONTHS, fmtClock, fmtDay, fmtDayShort, fmtKwh, fmtMonthShort } from '../format.ts';
import type { EnergyBucket, EnergyRow } from '../types.ts';
import { h, s } from '../ui/dom.ts';
import { MARGIN, placeTip, tipRow, xLabel, yAxis } from './line-chart.ts';

export interface EnergyChartData {
  rows: readonly EnergyRow[];
  bucket: EnergyBucket;
}

const FALLBACK_WIDTH = 340;
const inWh = (r: EnergyRow) => r.gridInWh + r.solarInWh;
const kwh = (wh: number) => `${fmtKwh(wh)} кВт·год`;
/** kWh with at most two decimals and no trailing zeros, for the axis. */
const axisKwh = (wh: number) => String(Number((wh / 1000).toFixed(2)));

/** Tooltip and table label of a bucket. */
export function bucketLabel(ts: number, bucket: EnergyBucket): string {
  if (bucket === 'hour') return `${fmtDayShort(ts)}, ${fmtClock(ts)}`;
  if (bucket === 'day') return fmtDay(ts);
  const d = new Date(ts * 1000);
  return `${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}

function axisLabel(ts: number, bucket: EnergyBucket): string {
  if (bucket === 'hour') return fmtClock(ts);
  if (bucket === 'day') return String(new Date(ts * 1000).getDate());
  return fmtMonthShort(ts);
}

export function createEnergyChart(o: { height?: number } = {}) {
  const height = o.height ?? 170;
  const svg = s('svg', { class: 'chart-svg', height, role: 'img', 'aria-label': 'Енергія', tabindex: 0 });
  const tip = h('div', { class: 'chart-tip', attrs: { 'aria-live': 'polite' } });
  tip.hidden = true;
  const el = h('div', { class: 'chart' }, svg, tip);
  let data: EnergyChartData | null = null;
  let width = 0;
  let slotW = 1;
  let active = -1;
  let slots: SVGGElement[] = [];

  function hide() {
    active = -1;
    for (const g of slots) g.classList.remove('is-dim');
    tip.hidden = true;
  }

  function show(i: number) {
    const d = data;
    if (!d || i < 0 || i >= d.rows.length) return hide();
    active = i;
    slots.forEach((g, k) => g.classList.toggle('is-dim', k !== i));
    const r = d.rows[i];
    const split = r.solarInWh > 0 ? [tipRow(null, kwh(r.gridInWh), 'з мережі'), tipRow(null, kwh(r.solarInWh), 'від сонця')] : [];
    tip.replaceChildren(
      h('div', { class: 'tip-time', text: bucketLabel(r.ts, d.bucket) }),
      tipRow(COLORS.in, kwh(inWh(r)), 'Отримано', 'bar'),
      tipRow(COLORS.out, kwh(r.outWh), 'Спожито', 'bar'),
      ...split,
    );
    placeTip(tip, MARGIN.left + slotW * (i + 0.5), width);
  }

  function render() {
    width = Math.round(el.clientWidth) || FALLBACK_WIDTH;
    svg.setAttribute('width', String(width));
    svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
    const d = data;
    if (!d) {
      svg.replaceChildren();
      return;
    }
    const plotW = Math.max(1, width - MARGIN.left - MARGIN.right);
    const base = height - MARGIN.bottom;
    const n = d.rows.length;
    slotW = plotW / Math.max(1, n);
    // Two columns per bucket with a 2 px gap between them and at least 2 px to the next bucket.
    const barW = Math.max(1, Math.min(24, Math.floor((slotW - 2) / 2 - 1)));
    const scale = niceTicks(0, Math.max(0, ...d.rows.map((r) => Math.max(inWh(r), r.outWh))), 4);
    const y = linear(scale.min, scale.max, base, MARGIN.top);
    const parts: SVGElement[] = [...yAxis(scale.ticks, y, width, axisKwh)];
    const every = Math.max(1, Math.ceil(n / Math.max(2, Math.floor(plotW / 44))));
    slots = d.rows.map((r, i) => {
      const cx = MARGIN.left + slotW * (i + 0.5);
      const bIn = s('path', { class: 'chart-bar', d: barPath(cx - 1 - barW, barW, y(inWh(r)), base) });
      bIn.style.setProperty('fill', COLORS.in);
      const bOut = s('path', { class: 'chart-bar', d: barPath(cx + 1, barW, y(r.outWh), base) });
      bOut.style.setProperty('fill', COLORS.out);
      if (i % every === 0) parts.push(xLabel(r1(cx), width, axisLabel(r.ts, d.bucket), height - 6));
      return s('g', { class: 'chart-slot' }, bIn, bOut);
    });
    parts.push(...slots);
    svg.replaceChildren(...parts);
    if (active >= 0) show(active);
  }

  const indexAt = (clientX: number) => {
    const n = data?.rows.length ?? 0;
    if (!n) return -1;
    const i = Math.floor((clientX - svg.getBoundingClientRect().left - MARGIN.left) / slotW);
    return Math.max(0, Math.min(n - 1, i));
  };
  svg.addEventListener('pointerdown', (e) => show(indexAt(e.clientX)));
  svg.addEventListener('pointermove', (e) => {
    if (e.pointerType === 'mouse' || e.buttons) show(indexAt(e.clientX));
  });
  svg.addEventListener('pointerleave', (e) => {
    if (e.pointerType === 'mouse') hide();
  });
  svg.addEventListener('pointercancel', hide);
  svg.addEventListener('blur', hide);
  svg.addEventListener('keydown', (e) => {
    const n = data?.rows.length ?? 0;
    if (!n) return;
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault();
      const next = active < 0 ? n - 1 : active + (e.key === 'ArrowLeft' ? -1 : 1);
      show(Math.max(0, Math.min(n - 1, next)));
    } else if (e.key === 'Escape') hide();
  });
  const onOutside = (e: PointerEvent) => {
    if (active >= 0 && !el.contains(e.target as Node)) hide();
  };
  document.addEventListener('pointerdown', onOutside);
  const ro =
    typeof ResizeObserver === 'undefined'
      ? null
      : new ResizeObserver(() => {
          if ((Math.round(el.clientWidth) || FALLBACK_WIDTH) !== width) render();
        });
  ro?.observe(el);

  return {
    el,
    update(d: EnergyChartData) {
      data = d;
      hide();
      render();
    },
    destroy() {
      ro?.disconnect();
      document.removeEventListener('pointerdown', onOutside);
    },
  };
}

/** Table twin of the energy chart, newest bucket first, in kWh. */
export function energyTable(d: EnergyChartData): { header: string[]; rows: string[][] } {
  return {
    header: ['Період', 'Отримано', 'Спожито'],
    rows: [...d.rows].reverse().map((r) => [bucketLabel(r.ts, d.bucket), fmtKwh(inWh(r)), fmtKwh(r.outWh)]),
  };
}
