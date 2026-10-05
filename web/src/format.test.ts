import { describe, expect, it } from 'vitest';
import { makeSnapshot } from '../../hub/src/test-helpers.ts';
import {
  DASH,
  describeAgent,
  flowOf,
  fmtClock,
  fmtDuration,
  fmtHex,
  fmtHours,
  fmtKwh,
  fmtW,
  forecastLine,
  gridLine,
  socTone,
} from './format.ts';
import type { StateView } from './types.ts';

const view = (o: Partial<StateView> = {}): StateView => ({
  link: 'up',
  snapshot: makeSnapshot(0),
  grid: { present: true, sinceSec: 1000 },
  outage: null,
  forecast: { capacityWh: 1024, avgLoadW: 85, runtimeHours: 7.2, stationRemainingMin: 3600 },
  today: { gridInWh: 1240, solarInWh: 0, outWh: 980 },
  ...o,
});

describe('numbers', () => {
  it('formats power and energy and never prints NaN', () => {
    expect(fmtW(85.6)).toBe('86');
    expect(fmtW(null)).toBe(DASH);
    expect(fmtW(Number.NaN)).toBe(DASH);
    expect(fmtKwh(1240)).toBe('1.24');
    expect(fmtKwh(15_400)).toBe('15.4');
    expect(fmtKwh(undefined)).toBe(DASH);
    expect(fmtHex(0)).toBe('0x00000000');
    expect(fmtHex(4)).toBe('0x00000004');
  });

  it('formats durations in Ukrainian', () => {
    expect(fmtDuration(30)).toBe('<1 хв');
    expect(fmtDuration(47 * 60)).toBe('47 хв');
    expect(fmtDuration(3 * 3600 + 5 * 60)).toBe('3 год 05 хв');
    expect(fmtDuration(2 * 86400 + 3 * 3600)).toBe('2 д 3 год');
    expect(fmtDuration(-5)).toBe(DASH);
    expect(fmtDuration(null)).toBe(DASH);
    expect(fmtHours(7.2)).toBe('7 год 12 хв');
    expect(fmtHours(null)).toBe(DASH);
  });

  it('formats clock time in the local zone (tests run in Europe/Kyiv)', () => {
    expect(fmtClock(Date.UTC(2026, 9, 6, 11, 32) / 1000)).toBe('14:32');
  });
});

describe('tones and flow', () => {
  it('colours the battery by charge', () => {
    expect(socTone(80)).toBe('ok');
    expect(socTone(51)).toBe('ok');
    expect(socTone(50)).toBe('warn');
    expect(socTone(21)).toBe('warn');
    expect(socTone(20)).toBe('bad');
  });

  it('derives the power flow', () => {
    expect(flowOf(makeSnapshot(0, { inW: 500, outW: 100 }))).toBe('charging');
    expect(flowOf(makeSnapshot(0, { inW: 0, outW: 120 }))).toBe('discharging');
    expect(flowOf(makeSnapshot(0, { inW: 86, outW: 86 }))).toBe('bypass');
    expect(flowOf(makeSnapshot(0, { inW: 0, outW: 0 }))).toBe('idle');
  });
});

describe('grid and forecast lines', () => {
  it('describes the grid state with its duration', () => {
    expect(gridLine(view(), 1000 + 3 * 3600 + 12 * 60)).toEqual({ tone: 'ok', text: 'Мережа є · 3 год 12 хв' });
    expect(gridLine(view({ grid: { present: true, sinceSec: null } }), 5000)).toEqual({ tone: 'ok', text: 'Мережа є' });
    const off = view({
      grid: { present: false, sinceSec: 2000 },
      outage: { id: 1, startTs: 1900, endTs: null, socStart: 80, socEnd: null, outWh: 10 },
    });
    expect(gridLine(off, 1900 + 47 * 60)).toEqual({ tone: 'bad', text: 'Відключення · 47 хв' });
    expect(gridLine(view({ grid: { present: null, sinceSec: null } }), 0)).toEqual({ tone: 'none', text: 'Стан мережі невідомий' });
  });

  it('phrases the forecast for grid and battery', () => {
    expect(forecastLine(view())).toBe('Якщо зникне світло — вистачить на ~7 год 12 хв');
    expect(forecastLine(view({ grid: { present: false, sinceSec: 0 } }))).toBe('Вистачить на ~7 год 12 хв');
    expect(forecastLine(view({ forecast: { capacityWh: 1024, avgLoadW: null, runtimeHours: null, stationRemainingMin: null } }))).toBe('');
  });
});

describe('describeAgent', () => {
  it('names the device and browser', () => {
    expect(describeAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1')).toBe('iPhone · Safari');
    expect(describeAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/130.0 Safari/537.36')).toBe('Mac · Chrome');
    expect(describeAgent('')).toBe('Невідомий пристрій');
  });
});
