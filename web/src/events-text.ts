import { fmtHex, type Tone } from './format.ts';
import { STATION_SETTINGS } from './settings-def.ts';
import type { EventSource, EventType, HubEvent } from './types.ts';

export interface EventFilter {
  id: string;
  label: string;
  types: readonly EventType[];
}

export const EVENT_FILTERS: readonly EventFilter[] = [
  { id: 'all', label: 'Усі', types: [] },
  { id: 'grid', label: 'Світло', types: ['grid_lost', 'grid_restored'] },
  { id: 'outputs', label: 'Виходи', types: ['output_changed'] },
  { id: 'settings', label: 'Налаштування', types: ['setting_changed'] },
  { id: 'battery', label: 'Батарея', types: ['soc_low'] },
  { id: 'faults', label: 'Помилки', types: ['fault_set', 'fault_cleared'] },
  { id: 'link', label: "Зв'язок", types: ['link_lost', 'link_restored', 'hub_started'] },
];

const OUTPUT_NAMES: Record<string, string> = { ac: 'AC', dc: 'DC', usb: 'USB', led: 'Ліхтар' };
const SOURCE: Record<EventSource, string> = { app: 'із застосунку', station: 'на станції', hub: '' };
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const join = (...parts: (string | false | null | undefined)[]) => parts.filter(Boolean).join(' · ');

/** A station setting value as the settings page shows it. */
export function settingValue(register: string, v: number): string {
  const def = STATION_SETTINGS.find((d) => d.register === register);
  if (!def) return String(v);
  if (def.kind === 'slider') return `${v} ${def.unit}`;
  if (def.kind === 'switch') return (def.invert ? v === 0 : v !== 0) ? 'увімк.' : 'вимк.';
  return def.options.find(([value]) => value === v)?.[1] ?? String(v);
}

export interface EventText {
  title: string;
  detail: string;
  tone: Tone;
}

export function describeEvent(e: HubEvent): EventText {
  const d = e.data;
  const source = SOURCE[e.source] ?? '';
  const soc = num(d.soc);
  const kind = String(d.kind ?? '').toUpperCase();
  switch (e.type) {
    case 'grid_lost':
      return d.initial === true
        ? { title: 'Світла немає', detail: join(soc !== null && `заряд ${soc}%`, 'на момент запуску хаба'), tone: 'bad' }
        : { title: 'Зникло світло', detail: join(soc !== null && `заряд ${soc}%`), tone: 'bad' };
    case 'grid_restored':
      return { title: 'Світло повернулось', detail: join(soc !== null && `заряд ${soc}%`), tone: 'ok' };
    case 'output_changed': {
      const name = OUTPUT_NAMES[String(d.output)] ?? String(d.output);
      return { title: `${name} ${num(d.to) ? 'увімкнено' : 'вимкнено'}`, detail: source, tone: 'none' };
    }
    case 'setting_changed': {
      const register = String(d.register);
      const label = STATION_SETTINGS.find((s) => s.register === register)?.label ?? `Налаштування ${register}`;
      const from = num(d.from);
      const to = num(d.to);
      return {
        title: label,
        detail: join(from !== null && to !== null && `${settingValue(register, from)} → ${settingValue(register, to)}`, source),
        tone: 'none',
      };
    }
    case 'fault_set': {
      const code = num(d.code);
      return { title: `Помилка ${kind}`, detail: code === null ? '' : `код ${fmtHex(code)}`, tone: 'bad' };
    }
    case 'fault_cleared':
      return { title: `Помилку ${kind} усунено`, detail: '', tone: 'ok' };
    case 'link_lost':
      return { title: "Зв'язок зі станцією втрачено", detail: '', tone: 'warn' };
    case 'link_restored':
      return { title: "Зв'язок зі станцією відновлено", detail: '', tone: 'ok' };
    case 'soc_low': {
      const threshold = num(d.threshold);
      return { title: 'Низький заряд', detail: join(soc !== null && `${soc}%`, threshold !== null && `поріг ${threshold}%`), tone: 'warn' };
    }
    case 'hub_started':
      return { title: 'Хаб запущено', detail: '', tone: 'none' };
    default:
      // A newer hub may send types this page does not know yet.
      return { title: String((e as { type: unknown }).type), detail: '', tone: 'none' };
  }
}
