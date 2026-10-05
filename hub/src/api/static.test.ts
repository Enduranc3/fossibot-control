import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Auth } from '../auth.ts';
import { openDb } from '../db.ts';
import { createHttpServer } from './http.ts';
import { resolveStatic } from './static.ts';

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of closers.splice(0)) await c();
});

function site() {
  const base = mkdtempSync(join(tmpdir(), 'web-'));
  const root = join(base, 'web');
  mkdirSync(join(root, 'assets'), { recursive: true });
  writeFileSync(join(root, 'index.html'), '<!doctype html><title>app</title>');
  writeFileSync(join(root, 'assets', 'app-1a2b.js'), 'console.log(1)');
  writeFileSync(join(root, 'sw.js'), 'self');
  writeFileSync(join(base, 'secret.txt'), 'top secret');
  return { root, base };
}

/** Raw request so the path is sent exactly as written (fetch would normalise ../). */
function get(port: number, path: string) {
  return new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }>((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method: 'GET' }, (res) => {
      let body = '';
      res.on('data', (d) => (body += d));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

async function serve(staticDir: string) {
  const auth = new Auth(openDb(':memory:'));
  const routes = [{ method: 'GET' as const, path: '/api/health', public: true, handler: () => ({ json: { ok: true } }) }];
  const server = createHttpServer({ routes, auth, allowedOrigins: [], staticDir });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  closers.push(() => new Promise<void>((r) => server.close(() => r())));
  return (server.address() as AddressInfo).port;
}

describe('resolveStatic', () => {
  it('stays inside the root', () => {
    const { root } = site();
    expect(resolveStatic(root, '/index.html')).toBe(join(root, 'index.html'));
    expect(resolveStatic(root, '/../secret.txt')).toBeNull();
    expect(resolveStatic(root, '/assets/../../secret.txt')).toBeNull();
    expect(resolveStatic(root, '/%2e%2e/secret.txt')).toBeNull();
    expect(resolveStatic(root, '/index.html%00.png')).toBeNull();
    expect(resolveStatic(root, '/%E0%A4%A')).toBeNull();
    expect(resolveStatic(root, '/assets')).toBeNull(); // directories are not files
  });
});

describe('static serving', () => {
  it('serves the app with security headers and the right caching', async () => {
    const { root } = site();
    const port = await serve(root);
    const index = await get(port, '/');
    expect(index.status).toBe(200);
    expect(index.headers['content-type']).toMatch(/text\/html/);
    expect(index.headers['cache-control']).toBe('no-cache');
    expect(index.headers['content-security-policy']).toContain("default-src 'self'");
    expect(index.headers['x-content-type-options']).toBe('nosniff');
    const asset = await get(port, '/assets/app-1a2b.js');
    expect(asset.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    expect(asset.headers['content-type']).toMatch(/javascript/);
    expect((await get(port, '/sw.js')).headers['cache-control']).toBe('no-cache');
  });

  it('falls back to index.html for app routes but not for missing assets', async () => {
    const { root } = site();
    const port = await serve(root);
    expect((await get(port, '/settings')).body).toContain('<title>app</title>');
    expect((await get(port, '/assets/missing.js')).status).toBe(404);
  });

  it('never serves files outside the root', async () => {
    const { root } = site();
    const port = await serve(root);
    for (const p of ['/../secret.txt', '/..%2fsecret.txt', '/%2e%2e/secret.txt', '/assets/..%2f..%2fsecret.txt']) {
      const r = await get(port, p);
      expect(r.body).not.toContain('top secret');
    }
  });

  it('keeps API routes working', async () => {
    const { root } = site();
    const port = await serve(root);
    expect(JSON.parse((await get(port, '/api/health')).body)).toEqual({ ok: true });
    expect((await get(port, '/api/nope')).status).toBe(404);
  });
});
