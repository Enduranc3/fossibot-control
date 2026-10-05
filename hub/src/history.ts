import type { HubEvent } from '../../shared/events.ts';
import type { EnergyTotals } from './context.ts';
import { SAMPLE_COLUMNS, type Db } from './db.ts';
import { rowToOutage, type Outage, type OutageRow } from './outages.ts';

export const HISTORY_METRICS = SAMPLE_COLUMNS.filter((c) => c !== 'ts') as Exclude<(typeof SAMPLE_COLUMNS)[number], 'ts'>[];
export type HistoryMetric = (typeof HISTORY_METRICS)[number];

export interface HistoryResult {
  table: 'samples_1s' | 'samples_10s';
  bucketSec: number;
  ts: number[];
  series: Record<string, { avg: (number | null)[]; min: (number | null)[]; max: (number | null)[] }>;
}

export function queryHistory(db: Db, q: { from: number; to: number; metrics: HistoryMetric[]; points: number }): HistoryResult {
  const span = Math.max(1, q.to - q.from);
  const table = span <= 6 * 3600 ? 'samples_1s' : 'samples_10s';
  const base = table === 'samples_1s' ? 1 : 10;
  const bucketSec = Math.max(base, Math.ceil(span / q.points / base) * base);
  const metrics = q.metrics.filter((m) => (HISTORY_METRICS as string[]).includes(m));
  const select = metrics.map((m) => `avg(${m}) AS "${m}.avg", min(${m}) AS "${m}.min", max(${m}) AS "${m}.max"`).join(', ');
  const rows = db
    .prepare(
      `SELECT (ts / ${bucketSec}) * ${bucketSec} AS b${select ? `, ${select}` : ''}
       FROM ${table} WHERE ts >= ? AND ts < ? GROUP BY b ORDER BY b`,
    )
    .all(q.from, q.to) as Record<string, number | null>[];
  const series: HistoryResult['series'] = {};
  for (const m of metrics) {
    series[m] = {
      avg: rows.map((r) => (r[`${m}.avg`] === null ? null : Math.round((r[`${m}.avg`] as number) * 10) / 10)),
      min: rows.map((r) => r[`${m}.min`]),
      max: rows.map((r) => r[`${m}.max`]),
    };
  }
  return { table, bucketSec, ts: rows.map((r) => r.b as number), series };
}

export interface EnergyRow {
  ts: number;
  label: string;
  gridInWh: number;
  solarInWh: number;
  outWh: number;
  acOutWh: number;
  dcOutWh: number;
  usbOutWh: number;
}

const BUCKET_FORMAT = { hour: '%Y-%m-%d %H:00', day: '%Y-%m-%d', month: '%Y-%m' } as const;
const r1 = (v: number) => Math.round(v * 10) / 10;

export function queryEnergy(db: Db, q: { from: number; to: number; bucket: 'hour' | 'day' | 'month' }): EnergyRow[] {
  const rows = db
    .prepare(
      `SELECT strftime('${BUCKET_FORMAT[q.bucket]}', hour_ts, 'unixepoch', 'localtime') AS label, min(hour_ts) AS ts,
              sum(grid_in_wh) AS g, sum(solar_in_wh) AS s, sum(out_wh) AS o,
              sum(ac_out_wh) AS ac, sum(dc_out_wh) AS dc, sum(usb_out_wh) AS usb
       FROM energy_hourly WHERE hour_ts >= ? AND hour_ts < ? GROUP BY label ORDER BY ts`,
    )
    .all(q.from, q.to) as { label: string; ts: number; g: number; s: number; o: number; ac: number; dc: number; usb: number }[];
  return rows.map((r) => ({
    ts: r.ts,
    label: r.label,
    gridInWh: r1(r.g),
    solarInWh: r1(r.s),
    outWh: r1(r.o),
    acOutWh: r1(r.ac),
    dcOutWh: r1(r.dc),
    usbOutWh: r1(r.usb),
  }));
}

export function energyTotalsSince(db: Db, sinceSec: number): EnergyTotals {
  const r = db
    .prepare('SELECT total(grid_in_wh) AS g, total(solar_in_wh) AS s, total(out_wh) AS o FROM energy_hourly WHERE hour_ts >= ?')
    .get(sinceSec) as { g: number; s: number; o: number };
  return { gridInWh: r1(r.g), solarInWh: r1(r.s), outWh: r1(r.o) };
}

export function localMidnight(nowSec: number): number {
  const d = new Date(nowSec * 1000);
  d.setHours(0, 0, 0, 0);
  return Math.floor(d.getTime() / 1000);
}

export function listOutages(db: Db, from: number, to: number): Outage[] {
  return (
    db
      .prepare('SELECT * FROM outages WHERE start_ts < ? AND (end_ts IS NULL OR end_ts > ?) ORDER BY start_ts DESC')
      .all(to, from) as unknown as OutageRow[]
  ).map(rowToOutage);
}

const pad = (n: number) => String(n).padStart(2, '0');

export function outageCalendar(db: Db, month: string, nowSec: number) {
  const [y, m] = month.split('-').map(Number);
  const monthStart = new Date(y, m - 1, 1).getTime() / 1000;
  const monthEnd = new Date(y, m, 1).getTime() / 1000;
  const outages = listOutages(db, monthStart, monthEnd);
  const daysInMonth = new Date(y, m, 0).getDate();
  const days: { date: string; outageSec: number }[] = [];
  for (let d = 1; d <= daysInMonth; d++) {
    const dayStart = new Date(y, m - 1, d).getTime() / 1000;
    const dayEnd = new Date(y, m - 1, d + 1).getTime() / 1000;
    let outageSec = 0;
    for (const o of outages) {
      outageSec += Math.max(0, Math.min(o.endTs ?? nowSec, dayEnd) - Math.max(o.startTs, dayStart));
    }
    days.push({ date: `${y}-${pad(m)}-${pad(d)}`, outageSec });
  }
  return {
    days,
    count: outages.filter((o) => o.startTs >= monthStart).length,
    totalSec: days.reduce((a, d) => a + d.outageSec, 0),
    longestSec: outages.reduce((a, o) => Math.max(a, (o.endTs ?? nowSec) - o.startTs), 0),
  };
}

interface EventRow {
  id: number;
  ts: number;
  type: HubEvent['type'];
  source: HubEvent['source'];
  data: string;
}

export function listEvents(db: Db, q: { from?: number; to?: number; types?: string[]; cursor?: number; limit: number }) {
  const where: string[] = [];
  const params: (number | string)[] = [];
  if (q.from !== undefined) where.push('ts >= ?'), params.push(q.from);
  if (q.to !== undefined) where.push('ts < ?'), params.push(q.to);
  if (q.cursor !== undefined) where.push('id < ?'), params.push(q.cursor);
  if (q.types?.length) where.push(`type IN (${q.types.map(() => '?').join(',')})`), params.push(...q.types);
  const rows = db
    .prepare(`SELECT * FROM events ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT ?`)
    .all(...params, q.limit + 1) as unknown as EventRow[];
  const page = rows.slice(0, q.limit);
  return {
    events: page.map((r): HubEvent => ({ id: r.id, ts: r.ts, type: r.type, source: r.source, data: JSON.parse(r.data) })),
    nextCursor: rows.length > q.limit ? page[page.length - 1].id : null,
  };
}

function csvCell(v: unknown): string {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCsv(header: string[], rows: unknown[][]): string {
  return [header.join(','), ...rows.map((r) => r.map(csvCell).join(','))].join('\n') + '\n';
}

export function exportCsv(db: Db, kind: 'samples' | 'energy' | 'events' | 'outages', from: number, to: number): string {
  if (kind === 'samples') {
    if (to - from > 31 * 86_400) throw new Error('range_too_large');
    const rows = db.prepare(`SELECT * FROM samples_10s WHERE ts >= ? AND ts < ? ORDER BY ts`).all(from, to) as Record<string, unknown>[];
    return toCsv([...SAMPLE_COLUMNS], rows.map((r) => SAMPLE_COLUMNS.map((c) => r[c])));
  }
  if (kind === 'energy') {
    const cols = ['hour_ts', 'grid_in_wh', 'solar_in_wh', 'out_wh', 'ac_out_wh', 'dc_out_wh', 'usb_out_wh'];
    const rows = db.prepare('SELECT * FROM energy_hourly WHERE hour_ts >= ? AND hour_ts < ? ORDER BY hour_ts').all(from, to) as Record<string, unknown>[];
    return toCsv(cols, rows.map((r) => cols.map((c) => r[c])));
  }
  if (kind === 'events') {
    const rows = db.prepare('SELECT * FROM events WHERE ts >= ? AND ts < ? ORDER BY id').all(from, to) as unknown as EventRow[];
    return toCsv(['id', 'ts', 'type', 'source', 'data'], rows.map((r) => [r.id, r.ts, r.type, r.source, r.data]));
  }
  const cols = ['id', 'start_ts', 'end_ts', 'soc_start', 'soc_end', 'out_wh'];
  const rows = db.prepare('SELECT * FROM outages WHERE start_ts >= ? AND start_ts < ? ORDER BY start_ts').all(from, to) as Record<string, unknown>[];
  return toCsv(cols, rows.map((r) => cols.map((c) => r[c])));
}
