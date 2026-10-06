import { describe, expect, it } from 'vitest';
import { areaPath, barPath, clipIntervals, linePath, nearestIndex, runs } from './path.ts';
import { linear, niceTicks, timeTicks } from './scale.ts';

const at = (m: number, d: number, h = 0, min = 0) => Math.floor(new Date(2026, m - 1, d, h, min).getTime() / 1000);

describe('scales', () => {
  it('maps linearly and survives a zero-width domain', () => {
    const x = linear(0, 100, 40, 340);
    expect(x(0)).toBe(40);
    expect(x(50)).toBe(190);
    expect(linear(5, 5, 10, 20)(5)).toBe(10);
  });

  it('picks round ticks and never returns NaN', () => {
    expect(niceTicks(0, 1234)).toEqual({ min: 0, max: 1500, ticks: [0, 500, 1000, 1500] });
    expect(niceTicks(0, 87, 4).ticks).toEqual([0, 25, 50, 75, 100]);
    expect(niceTicks(0, 0)).toEqual({ min: 0, max: 1, ticks: [0, 0.25, 0.5, 0.75, 1] });
    expect(niceTicks(Number.NaN, Infinity).ticks.every(Number.isFinite)).toBe(true);
    expect(niceTicks(0.1, 0.3).ticks).toEqual([0.1, 0.15, 0.2, 0.25, 0.3]);
  });

  it('puts time ticks on round local hours, days and months', () => {
    expect(timeTicks(at(10, 6, 12, 10), at(10, 6, 18, 10), 4).map((t) => t.label)).toEqual(['14:00', '16:00', '18:00']);
    expect(timeTicks(at(10, 1, 9), at(10, 6, 9), 6).map((t) => t.label)).toEqual(['2 жовт', '3 жовт', '4 жовт', '5 жовт', '6 жовт']);
    const year = timeTicks(at(10, 6) - 365 * 86_400, at(10, 6), 5);
    // 3-month steps on months divisible by 3; January is labelled with the year.
    expect(year.map((t) => t.label)).toEqual(['2026', 'квіт', 'лип', 'жовт']);
    expect(timeTicks(10, 10, 4)).toEqual([]);
  });
});

describe('paths', () => {
  const ts = [0, 100, 200, 300, 600, 700];
  const values = [10, 20, null, 40, 50, 60];
  const id = (v: number) => v;

  it('breaks lines at missing values and long gaps', () => {
    expect(runs(ts, values, 200)).toEqual([[0, 1], [3], [4, 5]]);
    const d = linePath(ts, values, id, id, 200);
    expect(d.match(/M/g)?.length).toBe(3);
    expect(d).toContain('M300 40h0.01'); // a lone point still shows as a dot
    expect(d).not.toContain('NaN');
  });

  it('closes areas down to the baseline and skips lone points', () => {
    const d = areaPath(ts, values, id, id, 0, 200);
    expect(d.match(/M/g)?.length).toBe(2);
    expect(d).toContain('M0 0L0 10L100 20L100 0Z');
  });

  it('rounds only the top of a bar', () => {
    expect(barPath(10, 8, 20, 100)).toBe('M10 100V24Q10 20 14 20H14Q18 20 18 24V100Z');
    expect(barPath(10, 8, 100, 100)).toBe('');
  });

  it('finds the nearest timestamp', () => {
    expect(nearestIndex(ts, 340)).toBe(3);
    expect(nearestIndex(ts, 690)).toBe(5);
    expect(nearestIndex(ts, -50)).toBe(0);
    expect(nearestIndex([], 5)).toBe(-1);
  });

  it('clips outages to the window and runs an ongoing one until now', () => {
    const list = [
      { startTs: 50, endTs: 150 },
      { startTs: 900, endTs: null },
      { startTs: 5, endTs: 20 },
    ];
    expect(clipIntervals(list, 100, 1000, 950)).toEqual([
      [100, 150],
      [900, 950],
    ]);
  });
});
