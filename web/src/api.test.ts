import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, api, onUnauthorized, request } from './api.ts';

afterEach(() => {
  vi.unstubAllGlobals();
  onUnauthorized(() => {});
});

function stubFetch(status: number, body: unknown) {
  const fn = vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }));
  vi.stubGlobal('fetch', fn);
  return fn;
}

describe('request', () => {
  it('returns JSON and sends JSON bodies with same-origin credentials', async () => {
    const fn = stubFetch(200, { ok: true });
    expect(await api.command('led', 1)).toEqual({ ok: true });
    const [url, init] = fn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/command');
    expect(init.method).toBe('POST');
    expect(init.credentials).toBe('same-origin');
    expect(JSON.parse(String(init.body))).toEqual({ register: 'led', value: 1 });
    expect(new Headers(init.headers).get('content-type')).toBe('application/json');
  });

  it('throws ApiError with the server message and code', async () => {
    stubFetch(409, { error: 'not_confirmed', message: 'Станція не підтвердила команду' });
    const err = (await api.command('led', 1).catch((e: unknown) => e)) as ApiError;
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(409);
    expect(err.code).toBe('not_confirmed');
    expect(err.message).toBe('Станція не підтвердила команду');
  });

  it('maps network failures and rate limits to friendly messages', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new TypeError('Failed to fetch'))));
    await expect(request('GET', '/api/state')).rejects.toMatchObject({ status: 0, code: 'network', message: "Немає зв'язку з хабом" });
    stubFetch(429, { error: 'too_many_attempts', retryAfterSec: 120 });
    await expect(api.login('x')).rejects.toMatchObject({ message: 'Забагато спроб. Спробуйте через 2 хв' });
  });

  it('calls the unauthorized handler on 401, except for the auth endpoints', async () => {
    const handler = vi.fn();
    onUnauthorized(handler);
    stubFetch(401, { error: 'unauthorized' });
    await api.state().catch(() => {});
    expect(handler).toHaveBeenCalledTimes(1);
    stubFetch(401, { error: 'wrong_password', message: 'Невірний пароль' });
    await api.login('nope').catch(() => {});
    expect(handler).toHaveBeenCalledTimes(1);
  });
});
