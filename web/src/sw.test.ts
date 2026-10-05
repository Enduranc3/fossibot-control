import { describe, expect, it, vi } from 'vitest';
import { registerServiceWorker } from './pwa.ts';
import { strategyFor } from './sw.ts';

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
