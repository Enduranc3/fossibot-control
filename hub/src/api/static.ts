import { createReadStream, statSync } from 'node:fs';
import type http from 'node:http';
import { extname, join, normalize, resolve, sep } from 'node:path';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
  '.json': 'application/json',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

export const SECURITY_HEADERS: Record<string, string> = {
  'content-security-policy':
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; " +
    "connect-src 'self'; manifest-src 'self'; worker-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
};

/** Maps a URL path to a file inside root; null when it escapes root, is malformed or is not a file. */
export function resolveStatic(root: string, urlPath: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return null;
  }
  if (decoded.includes('\0')) return null;
  const base = resolve(root);
  const full = join(base, normalize(decoded).replace(/^[/\\]+/, ''));
  if (full !== base && !full.startsWith(base + sep)) return null;
  try {
    return statSync(full).isFile() ? full : null;
  } catch {
    return null;
  }
}

/** Serves a file for GET/HEAD; returns false when nothing matched (the caller answers 404). */
export function serveStatic(root: string, pathname: string, method: string, res: http.ServerResponse): boolean {
  if (method !== 'GET' && method !== 'HEAD') return false;
  const isAsset = pathname.startsWith('/assets/');
  let file = resolveStatic(root, pathname === '/' ? '/index.html' : pathname);
  // App routes (no file extension) get the shell; missing assets stay 404.
  if (!file && !isAsset && !extname(pathname)) file = resolveStatic(root, '/index.html');
  if (!file) return false;
  res.writeHead(200, {
    ...SECURITY_HEADERS,
    'content-type': TYPES[extname(file)] ?? 'application/octet-stream',
    'cache-control': isAsset ? 'public, max-age=31536000, immutable' : 'no-cache',
  });
  if (method === 'HEAD') {
    res.end();
    return true;
  }
  createReadStream(file)
    .on('error', () => res.destroy())
    .pipe(res);
  return true;
}
