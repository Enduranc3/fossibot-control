import type { Snapshot, StateView } from './types.ts';

export const DASH = '—';
const ok = (v: number | null | undefined): v is number => typeof v === 'number' && Number.isFinite(v);

export function fmtW(w: number | null | undefined): string {
  return ok(w) ? String(Math.round(w)) : DASH;
}

export function fmtKwh(wh: number | null | undefined): string {
  if (!ok(wh)) return DASH;
  const k = wh / 1000;
  return k < 10 ? k.toFixed(2) : k.toFixed(1);
}

export function fmtDuration(sec: number | null | undefined): string {
  if (!ok(sec) || sec < 0) return DASH;
  const m = Math.floor(sec / 60);
  if (m < 1) return '<1 хв';
  const d = Math.floor(m / 1440);
  const h = Math.floor((m % 1440) / 60);
  const mm = m % 60;
  if (d) return `${d} д ${h} год`;
  if (h) return `${h} год ${String(mm).padStart(2, '0')} хв`;
  return `${mm} хв`;
}

export function fmtHours(h: number | null | undefined): string {
  return ok(h) ? fmtDuration(Math.round(h * 3600)) : DASH;
}

export function fmtClock(sec: number): string {
  return new Date(sec * 1000).toLocaleTimeString('uk-UA', { hour: '2-digit', minute: '2-digit', hour12: false });
}

export function fmtHex(n: number): string {
  return `0x${(n >>> 0).toString(16).toUpperCase().padStart(8, '0')}`;
}

export type Tone = 'ok' | 'warn' | 'bad' | 'none';

export function socTone(soc: number): Tone {
  if (soc > 50) return 'ok';
  if (soc > 20) return 'warn';
  return 'bad';
}

export type Flow = 'charging' | 'discharging' | 'bypass' | 'idle';

export const FLOW_LABEL: Record<Flow, string> = {
  charging: 'Заряджання',
  discharging: 'Від батареї',
  bypass: 'Від мережі',
  idle: 'Очікування',
};

export function flowOf(s: Snapshot): Flow {
  const net = s.inW - s.outW;
  if (net > 5) return 'charging';
  if (net < -5) return 'discharging';
  return s.inW > 5 ? 'bypass' : 'idle';
}

export function gridLine(view: StateView, nowSec: number): { tone: Tone; text: string } {
  const { present, sinceSec } = view.grid;
  if (present === true) {
    return { tone: 'ok', text: sinceSec === null ? 'Мережа є' : `Мережа є · ${fmtDuration(nowSec - sinceSec)}` };
  }
  if (present === false) {
    const start = view.outage?.startTs ?? sinceSec;
    return { tone: 'bad', text: start === null ? 'Відключення' : `Відключення · ${fmtDuration(nowSec - start)}` };
  }
  return { tone: 'none', text: 'Стан мережі невідомий' };
}

export function forecastLine(view: StateView): string {
  const h = view.forecast.runtimeHours;
  if (!ok(h)) return '';
  return view.grid.present === false ? `Вистачить на ~${fmtHours(h)}` : `Якщо зникне світло — вистачить на ~${fmtHours(h)}`;
}

export function describeAgent(ua: string): string {
  const device = /iPhone/.test(ua)
    ? 'iPhone'
    : /iPad/.test(ua)
      ? 'iPad'
      : /Android/.test(ua)
        ? 'Android'
        : /Macintosh/.test(ua)
          ? 'Mac'
          : /Windows/.test(ua)
            ? 'Windows'
            : '';
  const browser = /CriOS|Chrome\//.test(ua) ? 'Chrome' : /FxiOS|Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : '';
  if (!device && !browser) return 'Невідомий пристрій';
  return [device, browser].filter(Boolean).join(' · ');
}

const pad2 = (n: number) => String(n).padStart(2, '0');
export const MONTHS = ['Січень', 'Лютий', 'Березень', 'Квітень', 'Травень', 'Червень', 'Липень', 'Серпень', 'Вересень', 'Жовтень', 'Листопад', 'Грудень'];
const MONTHS_GEN = ['січня', 'лютого', 'березня', 'квітня', 'травня', 'червня', 'липня', 'серпня', 'вересня', 'жовтня', 'листопада', 'грудня'];
const MONTHS_SHORT = ['січ', 'лют', 'бер', 'квіт', 'трав', 'черв', 'лип', 'серп', 'вер', 'жовт', 'лист', 'груд'];
const WEEKDAYS = ['Нд', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'];

/** 'YYYY-MM-DD' of the local day. */
export function dateValue(sec: number): string {
  const d = new Date(sec * 1000);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

export function fmtDay(sec: number, withYear = false): string {
  const d = new Date(sec * 1000);
  return `${d.getDate()} ${MONTHS_GEN[d.getMonth()]}${withYear ? ` ${d.getFullYear()}` : ''}`;
}

export function fmtDayShort(sec: number, withYear = false): string {
  const d = new Date(sec * 1000);
  return `${d.getDate()} ${MONTHS_SHORT[d.getMonth()]}${withYear ? ` ${d.getFullYear()}` : ''}`;
}

export function fmtMonthShort(sec: number): string {
  return MONTHS_SHORT[new Date(sec * 1000).getMonth()];
}

export function fmtDateTime(sec: number): string {
  return `${fmtDayShort(sec)}, ${fmtClock(sec)}`;
}

export function fmtWeekdayDay(sec: number): string {
  return `${WEEKDAYS[new Date(sec * 1000).getDay()]}, ${fmtDayShort(sec)}`;
}

/** «Сьогодні», «Вчора» or the date (with the year when it is not this year). */
export function dayHeader(sec: number, nowSec: number): string {
  const key = dateValue(sec);
  if (key === dateValue(nowSec)) return 'Сьогодні';
  const yesterday = new Date(nowSec * 1000);
  yesterday.setDate(yesterday.getDate() - 1);
  if (key === dateValue(yesterday.getTime() / 1000)) return 'Вчора';
  return fmtDay(sec, new Date(sec * 1000).getFullYear() !== new Date(nowSec * 1000).getFullYear());
}
