import { MONTHS, dateValue, fmtClock, fmtDateTime, fmtDayShort } from './format.ts';
import type { EnergyBucket } from './types.ts';

export type Preset = '6h' | 'day' | 'week' | 'month' | 'year' | 'custom';
export type RollingPreset = Exclude<Preset, 'custom'>;

/** A time window in unix seconds, `to` exclusive. */
export interface Period {
  preset: Preset;
  from: number;
  to: number;
}

export const PRESETS: readonly { id: Preset; label: string }[] = [
  { id: '6h', label: '6 год' },
  { id: 'day', label: 'Доба' },
  { id: 'week', label: 'Тиждень' },
  { id: 'month', label: 'Місяць' },
  { id: 'year', label: 'Рік' },
  { id: 'custom', label: 'Свій' },
];

const SPAN_SEC: Record<RollingPreset, number> = { '6h': 6 * 3600, day: 86_400, week: 7 * 86_400, month: 30 * 86_400, year: 365 * 86_400 };
const LIVE_LABEL: Record<RollingPreset, string> = {
  '6h': 'Останні 6 годин',
  day: 'Остання доба',
  week: 'Останній тиждень',
  month: 'Останні 30 днів',
  year: 'Останній рік',
};

/** Rolling window that ends now. */
export function presetPeriod(preset: RollingPreset, nowSec: number): Period {
  return { preset, from: nowSec - SPAN_SEC[preset], to: nowSec };
}

/** A window that ends within the last 2 minutes follows the clock. */
export function isLive(p: Period, nowSec: number): boolean {
  return nowSec - p.to < 120;
}

/** Moves the window by its own length, never past now. */
export function shiftPeriod(p: Period, dir: -1 | 1, nowSec: number): Period {
  const span = p.to - p.from;
  const to = Math.min(nowSec, p.to + dir * span);
  return { preset: p.preset, from: to - span, to };
}

/** Local midnight of 'YYYY-MM-DD', or null for anything that is not a real date. */
export function parseDate(v: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(y, mo - 1, d);
  return date.getFullYear() === y && date.getMonth() === mo - 1 && date.getDate() === d ? date : null;
}

export function dateStart(v: string): number | null {
  const d = parseDate(v);
  return d ? d.getTime() / 1000 : null;
}

/** Whole local days, both dates inclusive; null when a date is missing or the range runs backwards. */
export function customPeriod(fromDate: string, toDate: string): Period | null {
  const a = parseDate(fromDate);
  const b = parseDate(toDate);
  if (!a || !b || b < a) return null;
  b.setDate(b.getDate() + 1);
  return { preset: 'custom', from: a.getTime() / 1000, to: b.getTime() / 1000 };
}

export function energyBucket(spanSec: number): EnergyBucket {
  if (spanSec <= 2 * 86_400) return 'hour';
  if (spanSec <= 92 * 86_400) return 'day';
  return 'month';
}

const isMidnight = (sec: number) => dateStart(dateValue(sec)) === sec;

export function periodLabel(p: Period, nowSec: number): string {
  if (p.preset !== 'custom' && isLive(p, nowSec)) return LIVE_LABEL[p.preset];
  const dayAligned = isMidnight(p.from) && isMidnight(p.to);
  if (!dayAligned && p.to - p.from <= 2 * 86_400) {
    return dateValue(p.from) === dateValue(p.to) ? `${fmtDateTime(p.from)} – ${fmtClock(p.to)}` : `${fmtDateTime(p.from)} – ${fmtDateTime(p.to)}`;
  }
  const last = dayAligned ? p.to - 1 : p.to;
  const year = new Date(nowSec * 1000).getFullYear();
  const withYear = new Date(p.from * 1000).getFullYear() !== year || new Date(last * 1000).getFullYear() !== year;
  if (dateValue(p.from) === dateValue(last)) return fmtDayShort(p.from, withYear);
  return `${fmtDayShort(p.from, withYear)} – ${fmtDayShort(last, withYear)}`;
}

export function monthKey(sec: number): string {
  return dateValue(sec).slice(0, 7);
}

export function shiftMonth(key: string, dir: -1 | 1): string {
  const [y, m] = key.split('-').map(Number);
  return monthKey(new Date(y, m - 1 + dir, 1).getTime() / 1000);
}

export function monthRange(key: string): { from: number; to: number } {
  const [y, m] = key.split('-').map(Number);
  return { from: new Date(y, m - 1, 1).getTime() / 1000, to: new Date(y, m, 1).getTime() / 1000 };
}

export function monthLabel(key: string): string {
  const [y, m] = key.split('-').map(Number);
  return `${MONTHS[m - 1]} ${y}`;
}
