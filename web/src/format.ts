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
