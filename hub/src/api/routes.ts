import { RateLimitError } from '../auth.ts';
import { CommandError } from '../command-queue.ts';
import type { HubContext } from '../context.ts';
import { HttpError, clearSessionCookie, sessionCookie, type ApiResponse, type Route } from './http.ts';
import { HISTORY_METRICS, exportCsv, listEvents, listOutages, outageCalendar, queryEnergy, queryHistory, type HistoryMetric } from '../history.ts';
import { validSubscription } from '../push.ts';

const STATUS_BY_COMMAND_ERROR = { invalid: 400, not_confirmed: 409, station_offline: 503 } as const;

function field(body: unknown, name: string): unknown {
  return body && typeof body === 'object' ? (body as Record<string, unknown>)[name] : undefined;
}

function passwordFrom(body: unknown): string {
  const p = field(body, 'password');
  if (typeof p !== 'string') throw new HttpError(400, 'bad_request', 'Потрібен пароль');
  return p;
}

function intParam(q: URLSearchParams, name: string, opts: { min?: number; max?: number; def?: number } = {}): number {
  const raw = q.get(name);
  if (raw === null || raw === '') {
    if (opts.def !== undefined) return opts.def;
    throw new HttpError(400, 'bad_request', `Потрібен параметр ${name}`);
  }
  const v = Number(raw);
  if (!Number.isInteger(v) || (opts.min !== undefined && v < opts.min) || (opts.max !== undefined && v > opts.max)) {
    throw new HttpError(400, 'bad_request', `Некоректний параметр ${name}`);
  }
  return v;
}

function range(q: URLSearchParams): { from: number; to: number } {
  const from = intParam(q, 'from', { min: 0 });
  const to = intParam(q, 'to', { min: 0 });
  if (to <= from) throw new HttpError(400, 'bad_request', 'to має бути більшим за from');
  return { from, to };
}

const nowSec = () => Math.floor(Date.now() / 1000);

function pushOf(ctx: HubContext) {
  if (!ctx.push) throw new HttpError(503, 'push_unavailable', 'Сповіщення недоступні');
  return ctx.push;
}

export function buildRoutes(ctx: HubContext): Route[] {
  return [
    {
      method: 'GET',
      path: '/api/health',
      public: true,
      handler: () => ({ json: { ok: true, link: ctx.state().link } }),
    },
    {
      method: 'GET',
      path: '/api/auth/status',
      public: true,
      handler: (req) => ({ json: { setUp: ctx.auth.isSetUp(), loggedIn: !!req.session } }),
    },
    {
      method: 'POST',
      path: '/api/setup',
      public: true,
      handler: async (req) => {
        if (ctx.auth.isSetUp()) throw new HttpError(409, 'already_set_up', 'Пароль уже задано');
        try {
          const token = await ctx.auth.setup(passwordFrom(req.body), req.userAgent);
          return { json: { ok: true }, headers: { 'set-cookie': sessionCookie(token) } };
        } catch (err) {
          if (err instanceof Error && err.message === 'password_too_short') {
            throw new HttpError(400, 'password_too_short', 'Пароль — щонайменше 8 символів');
          }
          throw err;
        }
      },
    },
    {
      method: 'POST',
      path: '/api/login',
      public: true,
      handler: async (req): Promise<ApiResponse> => {
        try {
          const token = await ctx.auth.login(passwordFrom(req.body), req.userAgent);
          if (!token) throw new HttpError(401, 'wrong_password', 'Невірний пароль');
          return { json: { ok: true }, headers: { 'set-cookie': sessionCookie(token) } };
        } catch (err) {
          if (err instanceof RateLimitError) {
            return {
              status: 429,
              json: { error: 'too_many_attempts', retryAfterSec: err.retryAfterSec },
              headers: { 'retry-after': String(err.retryAfterSec) },
            };
          }
          throw err;
        }
      },
    },
    {
      method: 'POST',
      path: '/api/logout',
      handler: (req) => {
        if (req.token) ctx.auth.logout(req.token);
        return { json: { ok: true }, headers: { 'set-cookie': clearSessionCookie() } };
      },
    },
    {
      method: 'GET',
      path: '/api/sessions',
      handler: (req) => ({
        json: ctx.auth.listSessions().map((s) => ({ ...s, current: s.id === req.session?.id })),
      }),
    },
    {
      method: 'DELETE',
      path: '/api/sessions/:id',
      handler: (req) => {
        if (!ctx.auth.revoke(req.params.id)) throw new HttpError(404, 'not_found');
        return { json: { ok: true } };
      },
    },
    { method: 'GET', path: '/api/state', handler: () => ({ json: ctx.state() }) },
    {
      method: 'GET',
      path: '/api/hub/info',
      handler: () => {
        if (!ctx.info) throw new HttpError(503, 'unavailable');
        return { json: ctx.info() };
      },
    },
    {
      method: 'POST',
      path: '/api/command',
      handler: async (req) => {
        const register = field(req.body, 'register');
        const value = field(req.body, 'value');
        if (typeof register !== 'string' || typeof value !== 'number') {
          throw new HttpError(400, 'invalid', 'Потрібні register (рядок) і value (число)');
        }
        try {
          await ctx.queue.execute(register, value);
          return { json: { ok: true } };
        } catch (err) {
          if (err instanceof CommandError) {
            throw new HttpError(STATUS_BY_COMMAND_ERROR[err.code], err.code, err.message);
          }
          throw err;
        }
      },
    },
    { method: 'GET', path: '/api/prefs', handler: () => ({ json: ctx.prefs.get() }) },
    {
      method: 'PUT',
      path: '/api/prefs',
      handler: (req) => {
        try {
          return { json: ctx.prefs.update(req.body) };
        } catch (err) {
          throw new HttpError(400, 'invalid', err instanceof Error ? err.message : String(err));
        }
      },
    },
    { method: 'GET', path: '/api/push/key', handler: () => ({ json: { publicKey: pushOf(ctx).publicKey() } }) },
    {
      method: 'POST',
      path: '/api/push/subscription',
      handler: (req) => {
        const sub = validSubscription(req.body);
        if (!sub) throw new HttpError(400, 'bad_subscription', 'Некоректна підписка');
        pushOf(ctx).subscribe(sub);
        return { json: { ok: true } };
      },
    },
    {
      method: 'DELETE',
      path: '/api/push/subscription',
      handler: (req) => {
        pushOf(ctx).unsubscribe(req.query.get('endpoint') ?? '');
        return { json: { ok: true } };
      },
    },
    {
      method: 'POST',
      path: '/api/push/test',
      handler: async () => {
        const push = pushOf(ctx);
        if (push.count() === 0) throw new HttpError(409, 'no_subscriptions', 'Немає підписаних пристроїв');
        const sent = await push.broadcast({ title: 'Перевірка сповіщень', body: 'Сповіщення з хаба працюють', tag: 'test', url: '/#/settings' });
        return { json: { sent } };
      },
    },
    {
      method: 'GET',
      path: '/api/history',
      handler: (req) => {
        const { from, to } = range(req.query);
        const metrics = (req.query.get('metrics') ?? 'soc').split(',').filter(Boolean);
        if (!metrics.length || metrics.some((m) => !(HISTORY_METRICS as string[]).includes(m))) {
          throw new HttpError(400, 'bad_request', 'Невідома метрика');
        }
        const points = intParam(req.query, 'points', { min: 10, max: 2000, def: 600 });
        return { json: queryHistory(ctx.db, { from, to, metrics: metrics as HistoryMetric[], points }) };
      },
    },
    {
      method: 'GET',
      path: '/api/energy',
      handler: (req) => {
        const { from, to } = range(req.query);
        const bucket = req.query.get('bucket') ?? 'day';
        if (bucket !== 'hour' && bucket !== 'day' && bucket !== 'month') throw new HttpError(400, 'bad_request', 'bucket: hour/day/month');
        return { json: queryEnergy(ctx.db, { from, to, bucket }) };
      },
    },
    {
      method: 'GET',
      path: '/api/outages',
      handler: (req) => {
        const { from, to } = range(req.query);
        return { json: listOutages(ctx.db, from, to) };
      },
    },
    {
      method: 'GET',
      path: '/api/outages/calendar',
      handler: (req) => {
        const month = req.query.get('month') ?? '';
        const m = /^(\d{4})-(\d{2})$/.exec(month);
        if (!m || Number(m[2]) < 1 || Number(m[2]) > 12) throw new HttpError(400, 'bad_request', 'month: YYYY-MM');
        return { json: outageCalendar(ctx.db, month, nowSec()) };
      },
    },
    {
      method: 'GET',
      path: '/api/events',
      handler: (req) => {
        const q = req.query;
        const types = (q.get('type') ?? '').split(',').filter(Boolean);
        return {
          json: listEvents(ctx.db, {
            from: q.has('from') ? intParam(q, 'from', { min: 0 }) : undefined,
            to: q.has('to') ? intParam(q, 'to', { min: 0 }) : undefined,
            cursor: q.has('cursor') ? intParam(q, 'cursor', { min: 1 }) : undefined,
            types,
            limit: intParam(q, 'limit', { min: 1, max: 200, def: 50 }),
          }),
        };
      },
    },
    {
      method: 'GET',
      path: '/api/export.csv',
      handler: (req) => {
        const kind = req.query.get('kind');
        if (kind !== 'samples' && kind !== 'energy' && kind !== 'events' && kind !== 'outages') {
          throw new HttpError(400, 'bad_request', 'kind: samples/energy/events/outages');
        }
        const { from, to } = range(req.query);
        try {
          return {
            text: exportCsv(ctx.db, kind, from, to),
            contentType: 'text/csv; charset=utf-8',
            headers: { 'content-disposition': `attachment; filename="fossibot-${kind}-${from}-${to}.csv"` },
          };
        } catch (err) {
          if (err instanceof Error && err.message === 'range_too_large') {
            throw new HttpError(400, 'range_too_large', 'Для посекундних даних — не більше 31 доби');
          }
          throw err;
        }
      },
    },
  ];
}
