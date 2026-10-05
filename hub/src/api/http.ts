import http from 'node:http';
import type { Auth, Session } from '../auth.ts';
import { serveStatic } from './static.ts';

export const SESSION_COOKIE = 'fb_session';
const MAX_BODY = 64 * 1024;

export interface ApiRequest {
  method: string;
  path: string;
  params: Record<string, string>;
  query: URLSearchParams;
  body: unknown;
  session: Session | null;
  token: string | null;
  userAgent: string;
}

export interface ApiResponse {
  status?: number;
  json?: unknown;
  text?: string;
  contentType?: string;
  headers?: Record<string, string>;
}

export interface Route {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  /** Path with optional :params, e.g. /api/sessions/:id */
  path: string;
  public?: boolean;
  handler(req: ApiRequest): ApiResponse | Promise<ApiResponse>;
}

export class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message?: string) {
    super(message ?? code);
    this.status = status;
    this.code = code;
  }
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i <= 0) continue;
    const raw = part.slice(i + 1).trim();
    try {
      out[part.slice(0, i).trim()] = decodeURIComponent(raw);
    } catch {
      out[part.slice(0, i).trim()] = raw; // malformed %-escape: keep as is, it simply won't match a session
    }
  }
  return out;
}

export const sessionCookie = (token: string) =>
  `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=31536000`;
export const clearSessionCookie = () => `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;

/** Requests without Origin (non-browser clients) pass; browser requests must come from our own host. */
export function originAllowed(req: http.IncomingMessage, allowed: string[]): boolean {
  const origin = req.headers.origin;
  if (!origin) return true;
  const host = req.headers.host;
  return origin === `https://${host}` || origin === `http://${host}` || allowed.includes(origin);
}

function matchRoute(routes: Route[], method: string, path: string) {
  const parts = path.split('/').filter(Boolean);
  for (const route of routes) {
    if (route.method !== method) continue;
    const want = route.path.split('/').filter(Boolean);
    if (want.length !== parts.length) continue;
    const params: Record<string, string> = {};
    if (want.every((seg, i) => (seg.startsWith(':') ? ((params[seg.slice(1)] = decodeURIComponent(parts[i])), true) : seg === parts[i]))) {
      return { route, params };
    }
  }
  return null;
}

function readJson(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new HttpError(413, 'too_large', 'Запит завеликий'));
        req.resume();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (size > MAX_BODY) return;
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text) return resolve({});
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(new HttpError(400, 'bad_json', 'Некоректний JSON'));
      }
    });
    req.on('error', reject);
  });
}

function send(res: http.ServerResponse, out: ApiResponse) {
  const headers: Record<string, string> = { 'cache-control': 'no-store', ...out.headers };
  let body: string;
  if (out.json !== undefined) {
    headers['content-type'] = 'application/json; charset=utf-8';
    body = JSON.stringify(out.json);
  } else {
    headers['content-type'] = out.contentType ?? 'text/plain; charset=utf-8';
    body = out.text ?? '';
  }
  res.writeHead(out.status ?? 200, headers);
  res.end(body);
}

export function createHttpServer(opts: {
  routes: Route[];
  auth: Auth;
  allowedOrigins: string[];
  staticDir?: string;
  log?: (m: string) => void;
}): http.Server {
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://hub');
      const method = req.method ?? 'GET';
      if (opts.staticDir && !url.pathname.startsWith('/api/') && serveStatic(opts.staticDir, url.pathname, method, res)) {
        return;
      }
      const found = matchRoute(opts.routes, method, url.pathname);
      if (!found) return send(res, { status: 404, json: { error: 'not_found' } });
      if (method !== 'GET' && !originAllowed(req, opts.allowedOrigins)) {
        return send(res, { status: 403, json: { error: 'bad_origin' } });
      }
      const token = parseCookies(req.headers.cookie)[SESSION_COOKIE] ?? null;
      const session = opts.auth.verify(token ?? undefined);
      if (!found.route.public && !session) return send(res, { status: 401, json: { error: 'unauthorized' } });
      const body = method === 'POST' || method === 'PUT' ? await readJson(req) : undefined;
      const out = await found.route.handler({
        method,
        path: url.pathname,
        params: found.params,
        query: url.searchParams,
        body,
        session,
        token,
        userAgent: String(req.headers['user-agent'] ?? ''),
      });
      send(res, out);
    } catch (err) {
      if (err instanceof HttpError) return send(res, { status: err.status, json: { error: err.code, message: err.message } });
      opts.log?.(`http: ${err instanceof Error ? err.stack : String(err)}`);
      send(res, { status: 500, json: { error: 'internal' } });
    }
  });
}
