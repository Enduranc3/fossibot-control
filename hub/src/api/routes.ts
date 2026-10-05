import { RateLimitError } from '../auth.ts';
import { CommandError } from '../command-queue.ts';
import type { HubContext } from '../context.ts';
import { HttpError, clearSessionCookie, sessionCookie, type ApiResponse, type Route } from './http.ts';

const STATUS_BY_COMMAND_ERROR = { invalid: 400, not_confirmed: 409, station_offline: 503 } as const;

function field(body: unknown, name: string): unknown {
  return body && typeof body === 'object' ? (body as Record<string, unknown>)[name] : undefined;
}

function passwordFrom(body: unknown): string {
  const p = field(body, 'password');
  if (typeof p !== 'string') throw new HttpError(400, 'bad_request', 'Потрібен пароль');
  return p;
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
  ];
}
