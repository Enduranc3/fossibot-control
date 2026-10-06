import { describe, expect, it } from 'vitest';
import { dateValue, dayHeader, fmtDateTime, fmtDay, fmtDayShort, fmtMonthShort, fmtWeekdayDay } from './format.ts';
import {
  customPeriod,
  dateStart,
  energyBucket,
  isLive,
  monthKey,
  monthLabel,
  monthRange,
  periodLabel,
  presetPeriod,
  shiftMonth,
  shiftPeriod,
} from './period.ts';

// Tests run with TZ=Europe/Kyiv.
const NOW = Math.floor(new Date(2026, 9, 6, 18, 0).getTime() / 1000);
const at = (m: number, d: number, h = 0, min = 0, y = 2026) => Math.floor(new Date(y, m - 1, d, h, min).getTime() / 1000);

describe('dates in Ukrainian', () => {
  it('formats days, months and times', () => {
    expect(dateValue(at(10, 5, 23, 59))).toBe('2026-10-05');
    expect(fmtDay(at(10, 5))).toBe('5 жовтня');
    expect(fmtDay(at(1, 2, 0, 0, 2025), true)).toBe('2 січня 2025');
    expect(fmtDayShort(at(10, 5))).toBe('5 жовт');
    expect(fmtMonthShort(at(3, 1))).toBe('бер');
    expect(fmtDateTime(at(10, 5, 14, 5))).toBe('5 жовт, 14:05');
    expect(fmtWeekdayDay(at(10, 5))).toBe('Пн, 5 жовт');
  });

  it('names today and yesterday in day headers', () => {
    expect(dayHeader(at(10, 6, 1), NOW)).toBe('Сьогодні');
    expect(dayHeader(at(10, 5, 23), NOW)).toBe('Вчора');
    expect(dayHeader(at(10, 1), NOW)).toBe('1 жовтня');
    expect(dayHeader(at(12, 31, 12, 0, 2025), NOW)).toBe('31 грудня 2025');
  });
});

describe('periods', () => {
  it('rolls presets up to now and shifts them by their own length, never past now', () => {
    const day = presetPeriod('day', NOW);
    expect(day).toEqual({ preset: 'day', from: NOW - 86_400, to: NOW });
    expect(isLive(day, NOW + 60)).toBe(true);
    const back = shiftPeriod(day, -1, NOW);
    expect(back).toEqual({ preset: 'day', from: NOW - 2 * 86_400, to: NOW - 86_400 });
    expect(isLive(back, NOW)).toBe(false);
    expect(shiftPeriod(back, 1, NOW)).toEqual(day);
    expect(shiftPeriod(day, 1, NOW)).toEqual(day);
  });

  it('turns two inclusive dates into whole local days, including the 25-hour DST day', () => {
    expect(customPeriod('2026-10-24', '2026-10-25')).toEqual({ preset: 'custom', from: at(10, 24), to: at(10, 26) });
    expect(at(10, 26) - at(10, 24)).toBe(49 * 3600);
    expect(customPeriod('2026-10-05', '2026-10-04')).toBeNull();
    expect(customPeriod('2026-02-30', '2026-03-01')).toBeNull();
    expect(customPeriod('', '2026-03-01')).toBeNull();
    expect(dateStart('2026-10-05')).toBe(at(10, 5));
    expect(dateStart('bad')).toBeNull();
  });

  it('picks energy buckets by span', () => {
    expect(energyBucket(6 * 3600)).toBe('hour');
    expect(energyBucket(86_400)).toBe('hour');
    expect(energyBucket(7 * 86_400)).toBe('day');
    expect(energyBucket(30 * 86_400)).toBe('day');
    expect(energyBucket(365 * 86_400)).toBe('month');
  });

  it('labels live windows, shifted windows and custom days', () => {
    expect(periodLabel(presetPeriod('day', NOW), NOW)).toBe('Остання доба');
    expect(periodLabel(presetPeriod('year', NOW), NOW)).toBe('Останній рік');
    expect(periodLabel(shiftPeriod(presetPeriod('6h', NOW), -1, NOW), NOW)).toBe('6 жовт, 06:00 – 12:00');
    expect(periodLabel(shiftPeriod(presetPeriod('day', NOW), -1, NOW), NOW)).toBe('4 жовт, 18:00 – 5 жовт, 18:00');
    expect(periodLabel(shiftPeriod(presetPeriod('year', NOW), -1, NOW), NOW)).toBe('6 жовт 2024 – 6 жовт 2025');
    expect(periodLabel(customPeriod('2026-10-05', '2026-10-05') as never, NOW)).toBe('5 жовт');
    expect(periodLabel(customPeriod('2026-10-04', '2026-10-05') as never, NOW)).toBe('4 жовт – 5 жовт');
  });

  it('walks months', () => {
    expect(monthKey(NOW)).toBe('2026-10');
    expect(shiftMonth('2026-01', -1)).toBe('2025-12');
    expect(shiftMonth('2026-12', 1)).toBe('2027-01');
    expect(monthRange('2026-10')).toEqual({ from: at(10, 1), to: at(11, 1) });
    expect(monthLabel('2026-10')).toBe('Жовтень 2026');
  });
});
