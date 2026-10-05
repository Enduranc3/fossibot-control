import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import type { HubEvent } from '../../shared/events.ts';
import { KEY } from '../../shared/protocol.ts';
import { StationSimulator } from '../../tools/station-sim.ts';
import type { StateView } from './context.ts';
import type { Outage } from './outages.ts';
import { runSafely, startHub, type RunningHub } from './hub.ts';
import { cookieFrom, until } from './test-helpers.ts';

/** Calls fn until ok(result) or timeout; returns the last result. */
async function poll<T>(fn: () => Promise<T>, ok: (v: T) => boolean, ms = 6000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (ok(v) || Date.now() > end) return v;
    await new Promise((r) => setTimeout(r, 100));
  }
}

const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const c of cleanup.splice(0)) await c();
});

async function boot() {
  const hub: RunningHub = await startHub({
    dataDir: mkdtempSync(join(tmpdir(), 'hub-e2e-')),
    httpHost: '127.0.0.1',
    httpPort: 0,
    stationHost: '127.0.0.1',
    stationPort: 0,
    allowedStationPrefix: '127.0.0.',
    allowedOrigins: [],
    confirmMs: 1000,
    flushIntervalMs: 100,
    gridRule: {
      lost: (s) => s.acInW <= 2 && s.outW > s.inW,
      restored: (s) => s.acInW > 2,
      lostAfterSec: 1,
      restoredAfterSec: 1,
    },
    log: () => {},
  });
  cleanup.push(() => hub.stop());
  const sim = new StationSimulator({ port: hub.stationPort, intervalMs: 100 });
  await sim.connect();
  cleanup.push(() => sim.disconnect());
  const base = `http://127.0.0.1:${hub.httpPort}`;
  const setup = await fetch(`${base}/api/setup`, { method: 'POST', body: JSON.stringify({ password: 'long enough' }) });
  const cookie = cookieFrom(setup);
  const get = async <T>(path: string) => (await (await fetch(base + path, { headers: { cookie } })).json()) as T;
  const post = (path: string, body: unknown) => fetch(base + path, { method: 'POST', headers: { cookie }, body: JSON.stringify(body) });
  return { hub, sim, base, cookie, get, post };
}

describe('hub end-to-end', () => {
  it('streams telemetry, records an outage and executes confirmed commands', async () => {
    const { sim, get, post } = await boot();
    const nowTo = () => Math.floor(Date.now() / 1000) + 10;

    const state = await poll(() => get<StateView>('/api/state'), (v) => v.link === 'up' && v.grid.present === true);
    expect(state.snapshot?.soc).toBe(60);
    expect(state.grid.present).toBe(true);

    sim.setGrid(false);
    let outages = await poll(() => get<Outage[]>(`/api/outages?from=0&to=${nowTo()}`), (v) => v.length > 0);
    expect(outages[0]).toMatchObject({ endTs: null });

    sim.setGrid(true);
    outages = await poll(() => get<Outage[]>(`/api/outages?from=0&to=${nowTo()}`), (v) => v[0]?.endTs !== null);
    expect(outages[0].endTs).not.toBeNull();
    expect(outages[0].outWh).toBeGreaterThan(0);

    const res = await post('/api/command', { register: 'acOn', value: 0 });
    expect(res.status).toBe(200);
    expect(sim.state[KEY.acOn]).toBe(0);

    sim.set(KEY.dcOn, 1); // "button" on the station
    const events = await poll(
      () => get<{ events: HubEvent[] }>('/api/events?limit=50'),
      (v) => v.events.some((e) => e.type === 'output_changed' && e.data.output === 'dc'),
    );
    const kinds = events.events.map((e) => `${e.type}:${e.source}`);
    expect(kinds).toContain('grid_lost:hub');
    expect(kinds).toContain('grid_restored:hub');
    expect(kinds).toContain('output_changed:app');
    expect(kinds).toContain('output_changed:station');
    expect(kinds).toContain('hub_started:hub');
  });

  it('pushes telemetry over the live socket', async () => {
    const { hub, cookie } = await boot();
    const ws = new WebSocket(`ws://127.0.0.1:${hub.httpPort}/api/live`, { headers: { cookie } });
    cleanup.push(() => ws.terminate());
    const types: string[] = [];
    ws.on('message', (d) => types.push(JSON.parse(String(d)).type));
    await until(() => types.includes('hello') && types.includes('telemetry'), 5000);
  });

  it('keeps serving live data when the database write fails', async () => {
    const log: string[] = [];
    expect(runSafely('flush', () => { throw new Error('disk full'); }, (m) => log.push(m))).toBe(false);
    expect(log[0]).toContain('disk full');
    expect(runSafely('flush', () => {}, (m) => log.push(m))).toBe(true);
  });

  it('keeps live data, commands and outage tracking working while the database is read-only', async () => {
    const { hub, sim, get, post, cookie } = await boot();
    const nowTo = () => Math.floor(Date.now() / 1000) + 10;
    await poll(() => get<StateView>('/api/state'), (v) => v.link === 'up' && v.grid.present === true);

    hub.ctx.db.exec('PRAGMA query_only = 1');
    sim.setGrid(false);
    const during = await poll(() => get<StateView>('/api/state'), (v) => v.outage !== null);
    expect(during.outage).not.toBeNull();
    expect((await post('/api/command', { register: 'led', value: 1 })).status).toBe(200);
    const ws = new WebSocket(`ws://127.0.0.1:${hub.httpPort}/api/live`, { headers: { cookie } });
    cleanup.push(() => ws.terminate());
    let hello = false;
    ws.on('message', (d) => (hello ||= JSON.parse(String(d)).type === 'hello'));
    await until(() => hello, 5000);

    hub.ctx.db.exec('PRAGMA query_only = 0');
    sim.setGrid(true);
    const outages = await poll(
      () => get<Outage[]>(`/api/outages?from=0&to=${nowTo()}`),
      (v) => v.length === 1 && v[0].endTs !== null,
    );
    expect(outages).toHaveLength(1);
    expect(outages[0].endTs).not.toBeNull();
    const events = await poll(
      () => get<{ events: HubEvent[] }>('/api/events?limit=50'),
      (v) => v.events.some((e) => e.type === 'grid_lost'),
    );
    expect(events.events.map((e) => e.type)).toContain('grid_lost');
  });
});

