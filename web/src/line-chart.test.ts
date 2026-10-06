// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { createChartCard } from './components/chart-card.ts';
import { MARGIN, createLineChart, lineTable, type LineData } from './components/line-chart.ts';

afterEach(() => document.body.replaceChildren());

const DATA: LineData = {
  from: 0,
  to: 1000,
  ts: [0, 100, 200, 300, 600, 700],
  bucketSec: 100,
  series: [
    { key: 'in', label: 'Вхід', color: 'var(--chart-in)', values: [10, 20, null, 40, 50, 60] },
    { key: 'out', label: 'Вихід', color: 'var(--chart-out)', values: [5, 5, 5, 5, 5, 5] },
  ],
  bands: [[250, 450]],
  extra: (i) => (i === 3 ? [['від сонця', '12 W']] : []),
};
const WIDTH = 340; // happy-dom has no layout, so the chart falls back to 340 px
const clientXFor = (t: number) => MARGIN.left + (t / 1000) * (WIDTH - MARGIN.left - MARGIN.right);
const tap = (target: Element, clientX: number) =>
  target.dispatchEvent(new PointerEvent('pointerdown', { clientX, pointerType: 'touch', bubbles: true }));

function mount() {
  const chart = createLineChart({ label: 'Потужність', format: (v) => `${v} W` });
  document.body.append(chart.el);
  chart.update(DATA);
  return chart;
}

describe('line chart', () => {
  it('draws a line per series, broken at missing values and gaps, over shaded outages', () => {
    const chart = mount();
    const lines = chart.el.querySelectorAll('.chart-line');
    expect(lines).toHaveLength(2);
    expect(lines[0].getAttribute('d')?.match(/M/g)?.length).toBe(3);
    expect(chart.el.querySelectorAll('.chart-band')).toHaveLength(1);
    expect(chart.el.querySelector('svg')?.outerHTML).not.toContain('NaN');
  });

  it('shows every series at the tapped point, value first, then the extra rows', () => {
    const chart = mount();
    tap(chart.el.querySelector('svg') as Element, clientXFor(320));
    const tip = chart.el.querySelector('.chart-tip') as HTMLElement;
    expect(tip.hidden).toBe(false);
    expect([...tip.querySelectorAll('.tip-row')].map((r) => r.textContent)).toEqual(['40 WВхід', '5 WВихід', '12 Wвід сонця']);
  });

  it('shows a dash and hides the marker where a series has no value', () => {
    const chart = mount();
    tap(chart.el.querySelector('svg') as Element, clientXFor(200));
    expect(chart.el.querySelector('.chart-tip')?.textContent).toContain('—Вхід');
    expect(chart.el.querySelectorAll('.chart-dot[visibility="hidden"]')).toHaveLength(1);
  });

  it('moves with arrow keys and hides on Escape or a tap elsewhere', () => {
    const chart = mount();
    const svg = chart.el.querySelector('svg') as SVGSVGElement;
    const tip = chart.el.querySelector('.chart-tip') as HTMLElement;
    svg.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight' }));
    expect(tip.textContent).toContain('60 W');
    svg.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft' }));
    expect(tip.textContent).toContain('50 W');
    svg.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(tip.hidden).toBe(true);
    tap(svg, clientXFor(0));
    expect(tip.hidden).toBe(false);
    document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    expect(tip.hidden).toBe(true);
    chart.destroy();
  });

  it('renders an empty window with axes and without NaN', () => {
    const chart = createLineChart({ label: 'Заряд', format: String });
    document.body.append(chart.el);
    chart.update({ from: 0, to: 1000, ts: [], bucketSec: 10, series: [{ key: 'soc', label: 'Заряд', color: 'red', values: [], area: true }], bands: [] });
    expect(chart.el.innerHTML).not.toContain('NaN');
    expect(chart.el.querySelectorAll('.chart-grid').length).toBeGreaterThan(1);
  });

  it('has a table twin, newest first, without rows where everything is missing', () => {
    const t = lineTable({ ...DATA, series: [DATA.series[0]] }, (v) => `${v} W`);
    expect(t.header).toEqual(['Час', 'Вхід']);
    expect(t.rows).toHaveLength(5);
    expect(t.rows[0][1]).toBe('60 W');
  });
});

describe('chart card', () => {
  it('builds the table only when asked and swaps the toggle label', () => {
    const card = createChartCard({ title: 'Потужність', legend: [{ label: 'Вхід', color: 'red', mark: 'line' }] });
    card.setTable(['Час', 'Вхід'], [['1 жовт, 10:00', '5 W']]);
    expect(card.el.querySelector('table')).toBeNull();
    const toggle = card.el.querySelector('.chart-toggle') as HTMLButtonElement;
    toggle.click();
    expect(card.el.querySelector('table')?.textContent).toContain('5 W');
    expect(toggle.textContent).toBe('Графік');
    expect((card.el.querySelector('.chart-body') as HTMLElement).hidden).toBe(true);
    card.setLoading(true);
    expect(card.el.dataset.loading).toBe('true');
    card.setEmpty(true);
    expect((card.el.querySelector('.chart-empty') as HTMLElement).hidden).toBe(false);
  });
});
