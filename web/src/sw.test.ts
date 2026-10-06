import { describe, expect, it, vi } from 'vitest';
import { registerServiceWorker } from './pwa.ts';
import { networkFirst, notificationFrom, strategyFor, type SwCache } from './sw.ts';

const O = 'https://fossibot-hub.x.ts.net';
const u = (p: string) => new URL(p, O);

describe('strategyFor', () => {
  it('never caches the API and other origins', () => {
    expect(strategyFor(u('/api/state'), O)).toBe('network-only');
    expect(strategyFor(u('/api/live'), O)).toBe('network-only');
    expect(strategyFor(new URL('https://example.com/x.js'), O)).toBe('network-only');
  });

  it('serves hashed assets from cache and the shell network-first', () => {
    expect(strategyFor(u('/assets/index-1a2b.js'), O)).toBe('cache-first');
    expect(strategyFor(u('/'), O)).toBe('network-first');
    expect(strategyFor(u('/manifest.webmanifest'), O)).toBe('network-first');
  });
});

describe('registerServiceWorker', () => {
  it('registers /sw.js when supported and reports failures as false', async () => {
    const register = vi.fn(async () => ({}));
    expect(await registerServiceWorker({ serviceWorker: { register } } as unknown as Navigator)).toBe(true);
    expect(register).toHaveBeenCalledWith('/sw.js');
    expect(await registerServiceWorker({ serviceWorker: { register: vi.fn(async () => Promise.reject(new Error('x'))) } } as unknown as Navigator)).toBe(false);
    expect(await registerServiceWorker({} as Navigator)).toBe(false);
    expect(await registerServiceWorker(undefined)).toBe(false);
  });
});

describe('networkFirst', () => {
  const navigate = { mode: 'navigate', url: `${O}/`, method: 'GET' } as unknown as Request;
  function cache(initial: Record<string, string> = {}) {
    const store = new Map(Object.entries(initial));
    const c: SwCache = {
      match: async (k) => {
        const key = typeof k === 'string' ? k : '/';
        return store.has(key) ? new Response(store.get(key)) : undefined;
      },
      put: async (k, res) => {
        store.set(typeof k === 'string' ? k : '/', await res.text());
      },
    };
    return { c, store };
  }

  it('stores and returns a good response', async () => {
    const { c, store } = cache();
    const res = await networkFirst(navigate, async () => new Response('fresh shell'), c);
    expect(await res.text()).toBe('fresh shell');
    expect(store.get('/')).toBe('fresh shell');
  });

  it('serves the cached shell when the hub behind Funnel answers 5xx', async () => {
    const { c } = cache({ '/': 'cached shell' });
    const res = await networkFirst(navigate, async () => new Response('Bad Gateway', { status: 502 }), c);
    expect(await res.text()).toBe('cached shell');
  });

  it('serves the cached shell when the network fails, and passes 5xx through without a cache', async () => {
    const { c } = cache({ '/': 'cached shell' });
    expect(await (await networkFirst(navigate, async () => Promise.reject(new TypeError('offline')), c)).text()).toBe('cached shell');
    const empty = cache();
    expect((await networkFirst(navigate, async () => new Response('x', { status: 503 }), empty.c)).status).toBe(503);
  });
});

describe('notifications', () => {
  it('turns a push payload into a notification that opens the right page', () => {
    expect(notificationFrom({ title: 'Зникло світло', body: 'заряд 84%', tag: 'grid_lost', url: '/#/outages' })).toEqual({
      title: 'Зникло світло',
      options: { body: 'заряд 84%', tag: 'grid_lost', icon: '/icons/icon-192.png', badge: '/icons/icon-192.png', data: { url: '/#/outages' } },
    });
  });

  it('survives an empty or broken payload', () => {
    expect(notificationFrom(null).title).toBe('Fossibot');
    expect(notificationFrom({ url: 'https://evil.example/' }).options.data.url).toBe('/');
  });
});
