// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { MARGIN } from './components/line-chart.ts';
import { bucketLabel, createEnergyChart, energyTable } from './components/energy-chart.ts';
import type { EnergyRow } from './types.ts';

afterEach(() => document.body.replaceChildren());

const day = (i: number) => Math.floor(new Date(2026, 8, 7 + i).getTime() / 1000); // 7 Sep + i; i = 29 → 6 Oct
const ROWS: EnergyRow[] = Array.from({ length: 30 }, (_, i) => ({
  ts: day(i),
  label: '',
  gridInWh: 1000 + i * 10,
  solarInWh: i === 29 ? 250 : 0,
  outWh: 800,
  acOutWh: 800,
  dcOutWh: 0,
  usbOutWh: 0,
}));
const HEIGHT = 170;
const SLOT = (340 - MARGIN.left - MARGIN.right) / 30;

function mount(rows: EnergyRow[] = ROWS) {
  const chart = createEnergyChart();
  document.body.append(chart.el);
  chart.update({ rows, bucket: 'day' });
  return chart;
}

describe('energy chart', () => {
  it('draws an in and an out column per bucket and thins the axis labels', () => {
    const chart = mount();
    expect(chart.el.querySelectorAll('.chart-slot')).toHaveLength(30);
    expect(chart.el.querySelectorAll('.chart-bar')).toHaveLength(60);
    const xLabels = [...chart.el.querySelectorAll('.chart-axis')].filter((t) => t.getAttribute('y') === String(HEIGHT - 6));
    expect(xLabels.map((t) => t.textContent)).toEqual(['7', '12', '17', '22', '27', '2']);
    expect(chart.el.innerHTML).not.toContain('NaN');
  });

  it('shows the tapped bucket with both totals and the solar split, dimming the others', () => {
    const chart = mount();
    const svg = chart.el.querySelector('svg') as SVGSVGElement;
    svg.dispatchEvent(new PointerEvent('pointerdown', { clientX: MARGIN.left + SLOT * 29.5, pointerType: 'touch', bubbles: true }));
    const tip = chart.el.querySelector('.chart-tip') as HTMLElement;
    expect(tip.hidden).toBe(false);
    expect([...tip.querySelectorAll('.tip-row')].map((r) => r.textContent)).toEqual([
      '1.54 кВт·годОтримано',
      '0.80 кВт·годСпожито',
      '1.29 кВт·годз мережі',
      '0.25 кВт·годвід сонця',
    ]);
    expect(tip.querySelector('.tip-time')?.textContent).toBe('6 жовтня');
    expect(chart.el.querySelectorAll('.chart-slot.is-dim')).toHaveLength(29);
    svg.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(chart.el.querySelectorAll('.chart-slot.is-dim')).toHaveLength(0);
    chart.destroy();
  });

  it('groups days into wider columns when a long custom range would make them overlap', () => {
    const rows = Array.from({ length: 92 }, (_, i) => ({ ...ROWS[0], ts: day(i), gridInWh: 1000, solarInWh: 0, outWh: 500 }));
    const chart = mount(rows);
    expect(chart.el.querySelectorAll('.chart-slot')).toHaveLength(31); // 3 days per column
    const spans = [...chart.el.querySelectorAll('.chart-bar')]
      .map((b) => (b.getAttribute('d') ?? '').match(/[\d.]+/g)?.map(Number) ?? [])
      .map((n) => [n[0], n[8]] as const)
      .sort((a, b) => a[0] - b[0]);
    for (let i = 1; i < spans.length; i++) expect(spans[i][0] - spans[i - 1][1]).toBeGreaterThanOrEqual(1.9);
    expect(spans.every(([a, b]) => b - a >= 2)).toBe(true);
    const svg = chart.el.querySelector('svg') as SVGSVGElement;
    svg.dispatchEvent(new PointerEvent('pointerdown', { clientX: MARGIN.left + 2, pointerType: 'touch', bubbles: true }));
    const tip = chart.el.querySelector('.chart-tip') as HTMLElement;
    expect(tip.querySelector('.tip-time')?.textContent).toBe('7 вересня – 9 вересня');
    expect(tip.textContent).toContain('3.00 кВт·годОтримано');
  });

  it('renders no columns and no NaN without data', () => {
    const chart = mount([]);
    expect(chart.el.querySelectorAll('.chart-bar')).toHaveLength(0);
    expect(chart.el.innerHTML).not.toContain('NaN');
  });

  it('labels buckets and has a table twin, newest first', () => {
    expect(bucketLabel(Math.floor(new Date(2026, 9, 6, 14).getTime() / 1000), 'hour')).toBe('6 жовт, 14:00');
    expect(bucketLabel(day(0), 'month')).toBe('Вересень 2026');
    const t = energyTable({ rows: ROWS, bucket: 'day' });
    expect(t.header).toEqual(['Період', 'Отримано', 'Спожито']);
    expect(t.rows[0]).toEqual(['6 жовтня', '1.54', '0.80']);
  });
});
