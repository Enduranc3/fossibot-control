import { fmtClock, fmtDayShort, fmtMonthShort } from '../format.ts';

/** Maps [d0, d1] onto [r0, r1]; a zero-width domain maps everything to r0. */
export function linear(d0: number, d1: number, r0: number, r1: number): (v: number) => number {
  const k = d1 === d0 ? 0 : (r1 - r0) / (d1 - d0);
  return (v) => r0 + (v - d0) * k;
}

/** Round axis bounds and ticks (1, 2, 2.5 or 5 × 10ⁿ apart) covering [min, max]. */
export function niceTicks(min: number, max: number, count = 4): { min: number; max: number; ticks: number[] } {
  let lo = Number.isFinite(min) ? min : 0;
  let hi = Number.isFinite(max) ? max : lo + 1;
  if (hi < lo) [lo, hi] = [hi, lo];
  if (hi === lo) hi = lo + (Math.abs(lo) || 1);
  const raw = (hi - lo) / Math.max(1, count);
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((f) => f * mag).find((s) => s >= raw) ?? 10 * mag;
  const start = Math.floor(lo / step + 1e-9) * step;
  const end = Math.ceil(hi / step - 1e-9) * step;
  const ticks: number[] = [];
  for (let i = 0; start + i * step <= end + step / 2; i++) ticks.push(Number((start + i * step).toPrecision(12)));
  return { min: ticks[0], max: ticks[ticks.length - 1], ticks };
}

export interface Tick {
  t: number;
  label: string;
}

const HOUR_STEPS = [300, 900, 1800, 3600, 7200, 10_800, 21_600, 43_200];
const DAY_STEPS = [1, 2, 7, 14];
const MONTH_STEPS = [1, 2, 3, 6, 12];

/** Ticks on round local times: hours for short windows, midnights for weeks, month starts for years. */
export function timeTicks(from: number, to: number, maxTicks: number): Tick[] {
  const span = to - from;
  if (!(span > 0) || maxTicks < 1) return [];
  const ticks: Tick[] = [];
  const midnight = new Date(from * 1000);
  midnight.setHours(0, 0, 0, 0);
  const sub = HOUR_STEPS.find((s) => span / s <= maxTicks);
  if (sub !== undefined) {
    const day0 = midnight.getTime() / 1000;
    for (let t = day0 + Math.ceil((from - day0) / sub) * sub; t <= to; t += sub) ticks.push({ t, label: fmtClock(t) });
    return ticks;
  }
  const days = DAY_STEPS.find((n) => span / (n * 86_400) <= maxTicks);
  if (days !== undefined) {
    const d = midnight;
    if (d.getTime() / 1000 < from) d.setDate(d.getDate() + 1);
    if (days >= 7) while (d.getDay() !== 1) d.setDate(d.getDate() + 1); // weeks start on Monday
    for (; d.getTime() / 1000 <= to; d.setDate(d.getDate() + days)) ticks.push({ t: d.getTime() / 1000, label: fmtDayShort(d.getTime() / 1000) });
    return ticks;
  }
  const months = MONTH_STEPS.find((n) => span / (n * 30.44 * 86_400) <= maxTicks) ?? 12;
  const d = midnight;
  d.setDate(1);
  if (d.getTime() / 1000 < from) d.setMonth(d.getMonth() + 1);
  while (d.getMonth() % months !== 0) d.setMonth(d.getMonth() + 1);
  for (; d.getTime() / 1000 <= to; d.setMonth(d.getMonth() + months)) {
    const t = d.getTime() / 1000;
    ticks.push({ t, label: d.getMonth() === 0 ? String(d.getFullYear()) : fmtMonthShort(t) });
  }
  return ticks;
}
