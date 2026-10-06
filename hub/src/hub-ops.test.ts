import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { startHub, type HubConfig, type RunningHub } from './hub.ts';
import { until } from './test-helpers.ts';
import { VERSION } from './version.ts';

const running: RunningHub[] = [];
afterEach(async () => {
  for (const h of running.splice(0)) await h.stop();
});

const FIVE_AM = Math.floor(new Date(2026, 9, 6, 5).getTime() / 1000);
const tmp = (name: string) => mkdtempSync(join(tmpdir(), `${name}-`));

async function start(over: Partial<HubConfig> = {}) {
  const logs: string[] = [];
  const hub = await startHub({
    dataDir: tmp('hub-ops'),
    httpHost: '127.0.0.1',
    httpPort: 0,
    stationHost: '127.0.0.1',
    stationPort: 0,
    allowedStationPrefix: '127.0.0.',
    allowedOrigins: [],
    log: (m) => logs.push(m),
    ...over,
  });
  running.push(hub);
  return { hub, logs, url: `http://127.0.0.1:${hub.httpPort}` };
}

describe('hub operations', () => {
  it('reports its version on /api/health so an updater can tell which release answers', async () => {
    const { url } = await start();
    expect(await (await fetch(`${url}/api/health`)).json()).toMatchObject({ ok: true, version: VERSION });
  });

  it('keeps running when a backup fails and tries again on the next tick', async () => {
    const runner = vi.fn<NonNullable<HubConfig['backupRunner']>>().mockRejectedValueOnce(new Error('no space left')).mockResolvedValue(undefined);
    const { logs, url } = await start({ backupDir: tmp('backups'), backupRunner: runner, backupIntervalMs: 20, backupClock: () => FIVE_AM });
    await until(() => runner.mock.calls.length >= 2);
    expect(logs).toContain('backup failed: no space left');
    expect((await fetch(`${url}/api/health`)).ok).toBe(true);
  });

  it('stops a running backup when the hub stops', async () => {
    let signal: AbortSignal | undefined;
    const runner = vi.fn<NonNullable<HubConfig['backupRunner']>>((_db, _dir, s) => {
      signal = s;
      return new Promise<void>(() => {});
    });
    const { hub } = await start({ backupDir: tmp('backups'), backupRunner: runner, backupClock: () => FIVE_AM });
    await until(() => signal !== undefined);
    running.splice(running.indexOf(hub), 1);
    await hub.stop();
    expect(signal?.aborted).toBe(true);
  });
});
