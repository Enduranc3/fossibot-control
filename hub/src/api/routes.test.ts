import { afterEach, describe, expect, it } from 'vitest';
import { Auth } from '../auth.ts';
import { CommandQueue } from '../command-queue.ts';
import type { HubContext, StateView } from '../context.ts';
import { openDb } from '../db.ts';
import { PrefsStore } from '../prefs.ts';
import { FakeLink, cookieFrom, makeSnapshot, startApi } from '../test-helpers.ts';

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of closers.splice(0)) await c();
});

function makeCtx(link = new FakeLink()) {
  const db = openDb(':memory:');
  const state = (): StateView => ({
    link: link.state,
    snapshot: makeSnapshot(1_759_700_000_000),
    grid: { present: true, sinceSec: 1_759_690_000 },
    outage: null,
    forecast: { capacityWh: 1024, avgLoadW: 85, runtimeHours: 7.2, stationRemainingMin: 3600 },
    today: { gridInWh: 1, solarInWh: 0, outWh: 1 },
  });
  const ctx: HubContext = { db, auth: new Auth(db), queue: new CommandQueue(link, { confirmMs: 300 }), prefs: new PrefsStore(db), state };
  return { ctx, link };
}

async function api(ctx: HubContext, origins: string[] = []) {
  const a = await startApi(ctx, origins);
  closers.push(a.close);
  const call = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
    fetch(a.url + path, {
      method,
      headers: { 'content-type': 'application/json', ...headers },
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    });
  return { ...a, call };
}

async function loggedIn() {
  const { ctx, link } = makeCtx();
  const a = await api(ctx);
  const res = await a.call('POST', '/api/setup', { password: 'long enough' });
  const cookie = cookieFrom(res);
  const as = (method: string, path: string, body?: unknown, h: Record<string, string> = {}) =>
    a.call(method, path, body, { cookie, ...h });
  return { ctx, link, a, cookie, as };
}

describe('auth routes', () => {
  it('reports status, sets up once and issues a secure cookie', async () => {
    const { ctx } = makeCtx();
    const a = await api(ctx);
    expect(await (await a.call('GET', '/api/auth/status')).json()).toEqual({ setUp: false, loggedIn: false });
    expect((await a.call('POST', '/api/setup', { password: 'short' })).status).toBe(400);
    const res = await a.call('POST', '/api/setup', { password: 'long enough' });
    expect(res.status).toBe(200);
    expect(res.headers.get('set-cookie')).toMatch(/^fb_session=.+; Path=\/; HttpOnly; Secure; SameSite=Strict; Max-Age=31536000$/);
    expect((await a.call('POST', '/api/setup', { password: 'long enough' })).status).toBe(409);
  });

  it('logs in, rejects wrong passwords and rate-limits', async () => {
    const { a } = await loggedIn();
    expect((await a.call('POST', '/api/login', { password: 'wrong pass' })).status).toBe(401);
    const ok = await a.call('POST', '/api/login', { password: 'long enough' });
    expect(ok.status).toBe(200);
    // the successful login above reset the counter, so five fresh failures are needed
    for (let i = 0; i < 5; i++) await a.call('POST', '/api/login', { password: 'wrong pass' });
    const limited = await a.call('POST', '/api/login', { password: 'long enough' });
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0);
  });

  it('protects private routes and supports logout', async () => {
    const { a, as } = await loggedIn();
    expect((await a.call('GET', '/api/state')).status).toBe(401);
    expect((await as('GET', '/api/state')).status).toBe(200);
    const out = await as('POST', '/api/logout');
    expect(out.headers.get('set-cookie')).toMatch(/Max-Age=0/);
    expect((await as('GET', '/api/state')).status).toBe(401);
  });

  it('lists and revokes sessions', async () => {
    const { as } = await loggedIn();
    const list = (await (await as('GET', '/api/sessions')).json()) as { id: string; current: boolean }[];
    expect(list).toHaveLength(1);
    expect(list[0].current).toBe(true);
    expect((await as('DELETE', `/api/sessions/${list[0].id}`)).status).toBe(200);
    expect((await as('GET', '/api/sessions')).status).toBe(401);
  });
});

describe('state, commands, prefs', () => {
  it('returns the state view', async () => {
    const { as } = await loggedIn();
    const body = (await (await as('GET', '/api/state')).json()) as StateView;
    expect(body.snapshot?.soc).toBe(60);
    expect(body.grid.present).toBe(true);
  });

  it('maps command outcomes to status codes', async () => {
    const { as, link } = await loggedIn();
    expect((await as('POST', '/api/command', { register: 'led', value: 1 })).status).toBe(200);
    expect(link.sent).toHaveLength(1);
    expect((await as('POST', '/api/command', { register: 'soc', value: 1 })).status).toBe(400);
    link.autoConfirm = false;
    const nc = await as('POST', '/api/command', { register: 'led', value: 2 });
    expect(nc.status).toBe(409);
    expect(await nc.json()).toMatchObject({ error: 'not_confirmed' });
    link.state = 'down';
    expect((await as('POST', '/api/command', { register: 'led', value: 0 })).status).toBe(503);
  });

  it('reads and validates prefs', async () => {
    const { as } = await loggedIn();
    expect(await (await as('GET', '/api/prefs')).json()).toMatchObject({ socLowThreshold: 20, capacityWh: 1024 });
    const ok = await as('PUT', '/api/prefs', { socLowThreshold: 30, notify: { output_changed: true } });
    expect(await ok.json()).toMatchObject({ socLowThreshold: 30, notify: { output_changed: true, grid_lost: true } });
    expect((await as('PUT', '/api/prefs', { socLowThreshold: 99 })).status).toBe(400);
    expect((await as('PUT', '/api/prefs', { notify: { nope: true } })).status).toBe(400);
  });
});

describe('request hygiene', () => {
  it('rejects foreign origins on writes but allows the same host and listed origins', async () => {
    const { a, as } = await loggedIn();
    expect((await as('POST', '/api/command', { register: 'led', value: 1 }, { origin: 'https://evil.example' })).status).toBe(403);
    const sameHost = new URL(a.url).host;
    expect((await as('POST', '/api/command', { register: 'led', value: 0 }, { origin: `http://${sameHost}` })).status).toBe(200);
  });

  it('answers malformed and oversized bodies with 400/413 and unknown paths with 404', async () => {
    const { as } = await loggedIn();
    expect((await as('POST', '/api/command', '{not json')).status).toBe(400);
    expect((await as('POST', '/api/command', { register: 'led', value: '1' })).status).toBe(400);
    expect((await as('POST', '/api/command', 'x'.repeat(70_000))).status).toBe(413);
    expect((await as('GET', '/api/nope')).status).toBe(404);
  });

  it('serves health without auth', async () => {
    const { a } = await loggedIn();
    expect(await (await a.call('GET', '/api/health')).json()).toEqual({ ok: true, link: 'up', version: 'dev' });
  });
});
describe('history routes', () => {
  it('validates parameters', async () => {
    const { as } = await loggedIn();
    expect((await as('GET', '/api/history?from=10&to=5&metrics=soc')).status).toBe(400);
    expect((await as('GET', '/api/history?from=0&to=100&metrics=password_hash')).status).toBe(400);
    expect((await as('GET', '/api/history?from=0&to=100&metrics=soc&points=600')).status).toBe(200);
    expect((await as('GET', '/api/energy?from=0&to=100&bucket=week')).status).toBe(400);
    expect((await as('GET', '/api/outages/calendar?month=2026-13')).status).toBe(400);
    expect((await as('GET', '/api/events?limit=500')).status).toBe(400);
    const csv = await as('GET', '/api/export.csv?kind=events&from=0&to=100');
    expect(csv.headers.get('content-type')).toMatch(/text\/csv/);
    expect((await as('GET', '/api/export.csv?kind=samples&from=0&to=99999999')).status).toBe(400);
  });
});
