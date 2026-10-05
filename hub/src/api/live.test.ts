import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import type { StateView } from '../context.ts';
import { Auth } from '../auth.ts';
import { openDb } from '../db.ts';
import { createHttpServer } from './http.ts';
import { LiveHub, type LiveMessage } from './live.ts';
import type { AddressInfo } from 'node:net';

const closers: (() => unknown)[] = [];
afterEach(async () => {
  for (const c of closers.splice(0)) await c();
});

const STATE = { link: 'up' } as unknown as StateView;

async function setup() {
  const auth = new Auth(openDb(':memory:'));
  const token = await auth.setup('long enough');
  const server = createHttpServer({ routes: [], auth, allowedOrigins: [] });
  const live = new LiveHub(server, { auth, allowedOrigins: [], hello: () => STATE });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  closers.push(() => live.close(), () => new Promise<void>((r) => server.close(() => r())));
  const { port } = server.address() as AddressInfo;
  return { live, token, url: `ws://127.0.0.1:${port}/api/live`, host: `127.0.0.1:${port}` };
}

function connect(url: string, headers: Record<string, string>) {
  const ws = new WebSocket(url, { headers });
  closers.push(() => ws.terminate());
  const messages: LiveMessage[] = [];
  ws.on('message', (d) => messages.push(JSON.parse(String(d))));
  return { ws, messages };
}

const until = async (fn: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 20));
  }
};

describe('LiveHub', () => {
  it('greets an authenticated client and delivers broadcasts', async () => {
    const { live, token, url, host } = await setup();
    const c = connect(url, { cookie: `fb_session=${token}`, origin: `http://${host}` });
    await until(() => c.messages.length === 1);
    expect(c.messages[0]).toEqual({ type: 'hello', state: STATE });
    live.broadcast({ type: 'link', state: 'down' });
    await until(() => c.messages.length === 2);
    expect(c.messages[1]).toEqual({ type: 'link', state: 'down' });
    expect(live.clientCount()).toBe(1);
  });

  it('rejects clients without a session or from a foreign origin', async () => {
    const { token, url } = await setup();
    const statusOf = (headers: Record<string, string>) =>
      new Promise<number>((resolve) => {
        const ws = new WebSocket(url, { headers });
        ws.on('error', () => {}); // a rejected handshake also emits 'error'; the status code is what we assert
        closers.push(() => ws.terminate());
        ws.on('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0));
      });
    expect(await statusOf({})).toBe(401);
    expect(await statusOf({ cookie: `fb_session=${token}`, origin: 'https://evil.example' })).toBe(403);
  });
});
