import { describe, expect, it } from 'vitest';
import { DEFAULT_CAPACITY_WH, LoadAverager, learnCapacity, runtimeHours } from './forecast.ts';

describe('learnCapacity', () => {
  it('moves 30 % towards the estimate from a long enough outage', () => {
    // 200 Wh for 20 % → 1000 Wh estimate
    expect(learnCapacity(1024, { outWh: 200, socStart: 80, socEnd: 60 })).toBe(Math.round(1024 * 0.7 + 1000 * 0.3));
  });

  it('ignores outages with less than a 10 % drop or missing SoC', () => {
    expect(learnCapacity(1024, { outWh: 50, socStart: 80, socEnd: 75 })).toBe(1024);
    expect(learnCapacity(1024, { outWh: 50, socStart: null, socEnd: 70 })).toBe(1024);
  });

  it('clamps to 50–150 % of the base capacity', () => {
    expect(learnCapacity(1024, { outWh: 10_000, socStart: 90, socEnd: 10 })).toBe(Math.round(DEFAULT_CAPACITY_WH * 1.5));
    expect(learnCapacity(600, { outWh: 10, socStart: 90, socEnd: 10 })).toBe(Math.round(DEFAULT_CAPACITY_WH * 0.5));
  });
});

describe('runtimeHours', () => {
  it('uses SoC above the discharge limit', () => {
    expect(runtimeHours(60, 10, 1000, 100)).toBeCloseTo(5);
  });

  it('is null for no or tiny load, and never negative', () => {
    expect(runtimeHours(60, 0, 1000, null)).toBeNull();
    expect(runtimeHours(60, 0, 1000, 3)).toBeNull();
    expect(runtimeHours(5, 10, 1000, 100)).toBe(0);
  });
});

describe('LoadAverager', () => {
  it('averages only the last window', () => {
    const a = new LoadAverager(10);
    expect(a.average()).toBeNull();
    a.add(0, 1000);
    a.add(5, 100);
    a.add(15, 100);
    expect(a.average()).toBe(100);
  });
});
