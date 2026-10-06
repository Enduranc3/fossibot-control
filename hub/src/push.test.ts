import { afterEach, describe, expect, it, vi } from 'vitest';
import type { HubEvent } from '../../shared/events.ts';
import { Auth } from './auth.ts';
import { CommandQueue } from './command-queue.ts';
import type { HubContext } from './context.ts';
import { openDb } from './db.ts';
import { PrefsStore } from './prefs.ts';
import { PushService, payloadFor, validSubscription, vapidKeys, type PushSend } from './push.ts';
import { FakeLink, cookieFrom, startApi } from './test-helpers.ts';

afterEach(() => vi.useRealTimers());

const SUB = { endpoint: 'https://web.push.apple.com/QGx1', keys: { p256dh: 'BKey', auth: 'auth1' } };
const ev = (type: HubEvent['type'], data: Record<string, unknown> = {}, source: HubEvent['source'] = 'hub'): HubEvent => ({ ts: 1_760_000_000, type, source, data });
const flush = () => new Promise((r) => setImmediate(r));

function setup(send = vi.fn<PushSend>(async () => {})) {
  const db = openDb(':memory:');
  const prefs = new PrefsStore(db);
  const log = vi.fn();
  const push = new PushService({ db, prefs: () => prefs.get(), send, log });
  push.subscribe(SUB);
  return { db, prefs, push, send, log };
}
const sentPayloads = (send: ReturnType<typeof vi.fn<PushSend>>) => send.mock.calls.map((c) => JSON.parse(c[1]) as Record<string, string>);

describe('push building blocks', () => {
  it('creates VAPID keys once and keeps them', () => {
    const db = openDb(':memory:');
    const a = vapidKeys(db);
    expect(vapidKeys(db)).toEqual(a);
    expect(a.publicKey).toMatch(/^[A-Za-z0-9_-]{80,}$/);
  });

  it('accepts only well-formed https subscriptions', () => {
    expect(validSubscription({ ...SUB, expirationTime: null })).toEqual(SUB);
    expect(validSubscription({ ...SUB, endpoint: 'http://insecure/x' })).toBeNull();
    expect(validSubscription({ endpoint: SUB.endpoint })).toBeNull();
    expect(validSubscription({ ...SUB, endpoint: `https://x/${'a'.repeat(2100)}` })).toBeNull();
    expect(validSubscription('nope')).toBeNull();
  });

  it('words notifications like the journal and links to the right page', () => {
    expect(payloadFor(ev('grid_lost', { soc: 84 }))).toEqual({ title: 'Зникло світло', body: 'заряд 84%', tag: 'grid_lost', url: '/#/outages' });
    expect(payloadFor(ev('fault_set', { kind: 'bms', code: 4 }, 'station')).url).toBe('/#/journal');
  });
});

describe('PushService', () => {
  it('notifies about an outage', async () => {
    const { push, send } = setup();
    push.onEvent(ev('grid_lost', { soc: 84 }));
    await flush();
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0]).toEqual(SUB);
    expect(sentPayloads(send)[0].title).toBe('Зникло світло');
  });

  it('respects the per-kind switches and skips the outage found at start', async () => {
    const { push, prefs, send } = setup();
    push.onEvent(ev('output_changed', { output: 'ac', from: 0, to: 1 }, 'app')); // off by default
    prefs.update({ notify: { grid_restored: false } });
    push.onEvent(ev('grid_restored', { soc: 50 }));
    push.onEvent(ev('grid_lost', { soc: 90, initial: true }));
    push.onEvent(ev('fault_cleared', { kind: 'pv', code: 4 }, 'station')); // never a notification
    await flush();
    expect(send).not.toHaveBeenCalled();
  });

  it('reports a lost station link only after two minutes, and not at all if it comes back', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { push, send } = setup();
    push.onEvent(ev('link_lost'));
    vi.advanceTimersByTime(119_000);
    push.onEvent(ev('link_restored'));
    vi.advanceTimersByTime(600_000);
    await flush();
    expect(send).not.toHaveBeenCalled();
    push.onEvent(ev('link_lost'));
    vi.advanceTimersByTime(120_000);
    await flush();
    expect(sentPayloads(send)).toEqual([{ title: "Зв'язок зі станцією втрачено", body: 'понад 2 хвилини', tag: 'link_lost', url: '/#/journal' }]);
    push.stop();
  });

  it('drops subscriptions the push service says are gone, keeps them on other errors', async () => {
    const gone = setup(vi.fn<PushSend>(async () => Promise.reject(Object.assign(new Error('Gone'), { statusCode: 410 }))));
    gone.push.onEvent(ev('grid_lost', { soc: 80 }));
    await flush();
    expect(gone.push.count()).toBe(0);
    const flaky = setup(vi.fn<PushSend>(async () => Promise.reject(Object.assign(new Error('Bad gateway'), { statusCode: 502 }))));
    expect(await flaky.push.broadcast(payloadFor(ev('grid_lost')))).toBe(0);
    expect(flaky.push.count()).toBe(1);
    expect(flaky.log).toHaveBeenCalledWith(expect.stringContaining('502'));
  });

  it('never throws out of onEvent, even when the database fails', async () => {
    const { push, db, log } = setup();
    db.close();
    expect(() => push.onEvent(ev('grid_lost', { soc: 1 }))).not.toThrow();
    await flush();
    expect(log).toHaveBeenCalled();
  });
});

describe('push routes', () => {
  it('serves the key, stores and removes subscriptions, sends a test and needs a login', async () => {
    const db = openDb(':memory:');
    const prefs = new PrefsStore(db);
    const send = vi.fn<PushSend>(async () => {});
    const push = new PushService({ db, prefs: () => prefs.get(), send });
    const ctx: HubContext = {
      db,
      auth: new Auth(db),
      queue: new CommandQueue(new FakeLink(), { confirmMs: 300 }),
      prefs,
      push,
      state: () => {
        throw new Error('unused');
      },
    };
    const a = await startApi(ctx);
    try {
      const call = (method: string, path: string, body?: unknown, cookie = '') =>
        fetch(a.url + path, { method, headers: { 'content-type': 'application/json', cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
      expect((await call('GET', '/api/push/key')).status).toBe(401);
      const cookie = cookieFrom(await call('POST', '/api/setup', { password: 'long enough' }));
      expect(await (await call('GET', '/api/push/key', undefined, cookie)).json()).toEqual({ publicKey: vapidKeys(db).publicKey });
      expect((await call('POST', '/api/push/test', {}, cookie)).status).toBe(409);
      expect((await call('POST', '/api/push/subscription', { endpoint: 'http://x' }, cookie)).status).toBe(400);
      expect((await call('POST', '/api/push/subscription', SUB, cookie)).status).toBe(200);
      expect(await (await call('POST', '/api/push/test', {}, cookie)).json()).toEqual({ sent: 1 });
      expect(sentPayloads(send)[0].title).toBe('Перевірка сповіщень');
      expect((await call('DELETE', `/api/push/subscription?endpoint=${encodeURIComponent(SUB.endpoint)}`, undefined, cookie)).status).toBe(200);
      expect(push.count()).toBe(0);
    } finally {
      await a.close();
    }
  });
});
