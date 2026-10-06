import { areaPath, linePath, nearestIndex, r1 } from '../charts/path.ts';
import { linear, niceTicks, timeTicks } from '../charts/scale.ts';
import { DASH, fmtDateTime } from '../format.ts';
import { h, s } from '../ui/dom.ts';
import { legendKey } from './chart-card.ts';

export interface LineSeries {
  key: string;
  label: string;
  color: string;
  values: readonly (number | null)[];
  /** Soft 10 % fill under the line (single-series charts only). */
  area?: boolean;
}

export interface LineData {
  from: number;
  to: number;
  ts: readonly number[];
  bucketSec: number;
  series: readonly LineSeries[];
  /** Outage intervals shaded behind the lines. */
  bands: readonly (readonly [number, number])[];
  /** Extra tooltip rows without a colour key, e.g. where the input power came from. */
  extra?: (i: number) => readonly (readonly [string, string])[];
}

export interface LineChartOptions {
  label: string;
  height?: number;
  yMin?: number;
  yMax?: number;
  yTicks?: readonly number[];
  format(v: number): string;
  axisFormat?(v: number): string;
}

export const MARGIN = { top: 10, right: 10, bottom: 24, left: 40 };
const FALLBACK_WIDTH = 340;

function svgText(cls: string, x: number, y: number, text: string, anchor: 'start' | 'middle' | 'end'): SVGTextElement {
  const t = s('text', { class: cls, x: r1(x), y: r1(y), 'text-anchor': anchor });
  t.textContent = text;
  return t;
}

/** An x-axis label anchored so it never spills past the chart edges. */
export function xLabel(x: number, width: number, text: string, y: number): SVGTextElement {
  const anchor = x < MARGIN.left + 18 ? 'start' : x > width - 18 ? 'end' : 'middle';
  return svgText('chart-axis', x, y, text, anchor);
}

export function yAxis(ticks: readonly number[], y: (v: number) => number, width: number, format: (v: number) => string): SVGElement[] {
  return ticks.flatMap((t) => {
    const yy = Math.round(y(t)) + 0.5;
    return [s('line', { class: 'chart-grid', x1: MARGIN.left, x2: width - MARGIN.right, y1: yy, y2: yy }), svgText('chart-axis', MARGIN.left - 6, yy + 3.5, format(t), 'end')];
  });
}

/** Places the tooltip beside x, on whichever side has more room. */
export function placeTip(tip: HTMLElement, x: number, width: number): void {
  tip.style.left = `${r1(x)}px`;
  tip.style.transform = x > width / 2 ? 'translateX(calc(-100% - 12px))' : 'translateX(12px)';
  tip.hidden = false;
}

export function tipRow(color: string | null, value: string, label: string, mark: 'line' | 'bar' = 'line'): HTMLElement {
  return h('div', { class: color ? 'tip-row' : 'tip-row tip-extra' }, color ? legendKey(color, mark) : null, h('b', { class: 'num', text: value }), h('span', { text: label }));
}

export function createLineChart(o: LineChartOptions) {
  const height = o.height ?? 180;
  const svg = s('svg', { class: 'chart-svg', height, role: 'img', 'aria-label': o.label, tabindex: 0 });
  const tip = h('div', { class: 'chart-tip', attrs: { 'aria-live': 'polite' } });
  tip.hidden = true;
  const el = h('div', { class: 'chart' }, svg, tip);
  const crossLine = s('line', { class: 'chart-cross', y1: MARGIN.top, y2: height - MARGIN.bottom });
  const cross = s('g', { visibility: 'hidden' }, crossLine);
  let dots: SVGCircleElement[] = [];
  let data: LineData | null = null;
  let width = 0;
  let active = -1;
  let x: (t: number) => number = () => 0;
  let y: (v: number) => number = () => 0;
  const plotWidth = () => Math.max(1, width - MARGIN.left - MARGIN.right);

  function hide() {
    active = -1;
    cross.setAttribute('visibility', 'hidden');
    tip.hidden = true;
  }

  function show(i: number) {
    const d = data;
    if (!d || i < 0 || i >= d.ts.length) return hide();
    active = i;
    const cx = r1(x(d.ts[i]));
    crossLine.setAttribute('x1', String(cx));
    crossLine.setAttribute('x2', String(cx));
    d.series.forEach((se, k) => {
      const v = se.values[i];
      const dot = dots[k];
      if (v === null || v === undefined) {
        dot.setAttribute('visibility', 'hidden');
        return;
      }
      dot.setAttribute('visibility', 'visible');
      dot.setAttribute('cx', String(cx));
      dot.setAttribute('cy', String(r1(y(v))));
    });
    cross.setAttribute('visibility', 'visible');
    tip.replaceChildren(
      h('div', { class: 'tip-time', text: fmtDateTime(d.ts[i]) }),
      ...d.series.map((se) => {
        const v = se.values[i];
        return tipRow(se.color, v === null || v === undefined ? DASH : o.format(v), se.label);
      }),
      ...(d.extra?.(i) ?? []).map(([label, value]) => tipRow(null, value, label)),
    );
    placeTip(tip, cx, width);
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
    const base = height - MARGIN.bottom;
    x = linear(d.from, d.to, MARGIN.left, MARGIN.left + plotWidth());
    const values = d.series.flatMap((se) => se.values.filter((v): v is number => v !== null && Number.isFinite(v)));
    const scale = o.yTicks
      ? { min: o.yMin ?? 0, max: o.yMax ?? 1, ticks: [...o.yTicks] }
      : niceTicks(o.yMin ?? Math.min(0, ...values), o.yMax ?? Math.max(0, ...values), 4);
    y = linear(scale.min, scale.max, base, MARGIN.top);
    const parts: SVGElement[] = [];
    for (const [a, b] of d.bands) {
      parts.push(s('rect', { class: 'chart-band', x: r1(x(a)), y: MARGIN.top, width: Math.max(1, r1(x(b) - x(a))), height: base - MARGIN.top }));
    }
    parts.push(...yAxis(scale.ticks, y, width, o.axisFormat ?? o.format));
    for (const tk of timeTicks(d.from, d.to, Math.max(2, Math.floor(plotWidth() / 70)))) parts.push(xLabel(x(tk.t), width, tk.label, height - 6));
    const gap = d.bucketSec * 2;
    for (const se of d.series) {
      if (se.area) {
        const area = s('path', { class: 'chart-area', d: areaPath(d.ts, se.values, x, y, base, gap) });
        area.style.setProperty('fill', se.color);
        parts.push(area);
      }
      const line = s('path', { class: 'chart-line', d: linePath(d.ts, se.values, x, y, gap), 'data-series': se.key });
      line.style.setProperty('stroke', se.color);
      parts.push(line);
    }
    dots = d.series.map((se) => {
      const dot = s('circle', { class: 'chart-dot', r: 4 });
      dot.style.setProperty('fill', se.color);
      return dot;
    });
    crossLine.setAttribute('y2', String(base));
    cross.replaceChildren(crossLine, ...dots);
    parts.push(cross);
    svg.replaceChildren(...parts);
    if (active >= 0) show(active);
  }

  const indexAt = (clientX: number) => {
    const d = data;
    if (!d || !d.ts.length) return -1;
    const left = svg.getBoundingClientRect().left;
    return nearestIndex(d.ts, d.from + ((clientX - left - MARGIN.left) / plotWidth()) * (d.to - d.from));
  };
  svg.addEventListener('pointerdown', (e) => show(indexAt(e.clientX)));
  svg.addEventListener('pointermove', (e) => {
    if (e.pointerType === 'mouse' || e.buttons) show(indexAt(e.clientX));
  });
  svg.addEventListener('pointerleave', (e) => {
    if (e.pointerType === 'mouse') hide();
  });
  // Vertical scrolling cancels the touch (touch-action: pan-y), which should not leave a stale tooltip.
  svg.addEventListener('pointercancel', hide);
  svg.addEventListener('blur', hide);
  svg.addEventListener('keydown', (e) => {
    const n = data?.ts.length ?? 0;
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
    update(d: LineData) {
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

/** Table twin of a line chart: newest first, skipping rows where every series is missing. */
export function lineTable(d: LineData, format: (v: number) => string): { header: string[]; rows: string[][] } {
  const rows: string[][] = [];
  for (let i = d.ts.length - 1; i >= 0; i--) {
    const cells = d.series.map((se) => se.values[i]);
    if (cells.every((v) => v === null || v === undefined)) continue;
    rows.push([fmtDateTime(d.ts[i]), ...cells.map((v) => (v === null || v === undefined ? DASH : format(v)))]);
  }
  return { header: ['Час', ...d.series.map((se) => se.label)], rows };
}
