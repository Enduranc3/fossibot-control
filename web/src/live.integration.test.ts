import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { startHub, type RunningHub } from '../../hub/src/hub.ts';
import { cookieFrom } from '../../hub/src/test-helpers.ts';
import { LiveClient, type SocketLike } from './live.ts';

const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const c of cleanup.splice(0)) await c();
});

describe('LiveClient against a real hub with no station', () => {
  it('stays online while the hub is quiet (the station is down)', async () => {
    const hub: RunningHub = await startHub({
      dataDir: mkdtempSync(join(tmpdir(), 'live-int-')),
      httpHost: '127.0.0.1',
      httpPort: 0,
      stationHost: '127.0.0.1',
      stationPort: 0,
      allowedOrigins: [],
      liveHeartbeatMs: 100,
      log: () => {},
    });
    cleanup.push(() => hub.stop());
    const setup = await fetch(`http://127.0.0.1:${hub.httpPort}/api/setup`, { method: 'POST', body: JSON.stringify({ password: 'long enough' }) });
    const cookie = cookieFrom(setup);
    const statuses: string[] = [];
    const client = new LiveClient({
      url: `ws://127.0.0.1:${hub.httpPort}/api/live`,
      onMessage: () => {},
      onStatus: (s) => statuses.push(s),
      createSocket: (u) => new WebSocket(u, { headers: { cookie } }) as unknown as SocketLike,
      staleMs: 400,
    });
    cleanup.push(() => client.stop());
    client.start();
    await new Promise((r) => setTimeout(r, 1500));
    expect(statuses).toEqual(['connecting', 'open']);
  });
});
