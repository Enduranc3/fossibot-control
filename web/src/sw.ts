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
    const store = (key: Request | string, res: Response) => {
      if (res.ok) void caches.open(CACHE_NAME).then((c) => c.put(key, res));
    };
    if (strategy === 'cache-first') {
      e.respondWith(
        caches.match(req).then(
          (hit) =>
            hit ??
            fetch(req).then((res) => {
              store(req, res.clone());
              return res;
            }),
        ),
      );
      return;
    }
    e.respondWith(
      fetch(req)
        .then((res) => {
          store(req.mode === 'navigate' ? '/' : req, res.clone());
          return res;
        })
        .catch(async () => (await caches.match(req)) ?? (await caches.match('/')) ?? Response.error()),
    );
  });
}
