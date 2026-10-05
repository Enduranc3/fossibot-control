// Service worker: keeps the app shell available without a network; never caches /api.
// Built separately by scripts/build-sw.mjs into dist/web/sw.js.

export const CACHE_NAME = 'fossibot-shell-v1';
export const SHELL_URLS = ['/', '/manifest.webmanifest', '/icons/icon-192.png', '/icons/apple-touch-icon.png'];

export type Strategy = 'network-only' | 'cache-first' | 'network-first';

export function strategyFor(url: URL, origin: string): Strategy {
  if (url.origin !== origin || url.pathname.startsWith('/api/')) return 'network-only';
  if (url.pathname.startsWith('/assets/')) return 'cache-first';
  return 'network-first';
}

export interface SwCache {
  match(key: Request | string): Promise<Response | undefined>;
  put(key: Request | string, res: Response): Promise<void>;
}

/**
 * Network first, cached shell as fallback — also when the hub is down behind Funnel (5xx),
 * not only when the network itself fails.
 */
export async function networkFirst(req: Request, fetchFn: (r: Request) => Promise<Response>, cache: SwCache): Promise<Response> {
  const key = req.mode === 'navigate' ? '/' : req;
  const cached = async () => (await cache.match(req)) ?? (await cache.match('/'));
  let res: Response;
  try {
    res = await fetchFn(req);
  } catch {
    return (await cached()) ?? Response.error();
  }
  if (res.ok) {
    await cache.put(key, res.clone());
    return res;
  }
  if (res.status >= 500) return (await cached()) ?? res;
  return res;
}

interface ExtendableEvent {
  waitUntil(p: Promise<unknown>): void;
}
interface FetchEvent extends ExtendableEvent {
  request: Request;
  respondWith(r: Promise<Response>): void;
}
interface Scope {
  location: Location;
  skipWaiting(): Promise<void>;
  clients: { claim(): Promise<void> };
  addEventListener(type: 'install' | 'activate', fn: (e: ExtendableEvent) => void): void;
  addEventListener(type: 'fetch', fn: (e: FetchEvent) => void): void;
}

const isWorker = typeof (globalThis as { ServiceWorkerGlobalScope?: unknown }).ServiceWorkerGlobalScope !== 'undefined';

if (isWorker) {
  const sw = globalThis as unknown as Scope;
  const swCache: SwCache = {
    match: (k) => caches.match(k),
    put: (k, res) => caches.open(CACHE_NAME).then((c) => c.put(k, res)),
  };

  sw.addEventListener('install', (e) => {
    e.waitUntil(
      caches
        .open(CACHE_NAME)
        .then((c) => c.addAll(SHELL_URLS))
        .then(() => sw.skipWaiting()),
    );
  });

  sw.addEventListener('activate', (e) => {
    e.waitUntil(
      caches
        .keys()
        .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
        .then(() => sw.clients.claim()),
    );
  });

  sw.addEventListener('fetch', (e) => {
    const req = e.request;
    if (req.method !== 'GET') return;
    const strategy = strategyFor(new URL(req.url), sw.location.origin);
    if (strategy === 'network-only') return;
    if (strategy === 'cache-first') {
      e.respondWith(
        caches.match(req).then(
          (hit) =>
            hit ??
            fetch(req).then((res) => {
              if (res.ok) void swCache.put(req, res.clone());
              return res;
            }),
        ),
      );
      return;
    }
    e.respondWith(networkFirst(req, (r) => fetch(r), swCache));
  });
}
