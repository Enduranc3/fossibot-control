import net from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { KEY, buildReport, buildWriteCommand } from '../../shared/protocol.ts';
import { StationSimulator } from '../../tools/station-sim.ts';
import { StationLink, StationOfflineError, type LinkState } from './station-link.ts';

const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const c of cleanup.splice(0)) await c();
});

const until = async (fn: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 20));
  }
};

async function startLink(opts: Partial<ConstructorParameters<typeof StationLink>[0]> = {}) {
  const link = new StationLink({ port: 0, host: '127.0.0.1', allowedPrefix: '127.0.0.', ...opts });
  await link.start();
  cleanup.push(() => link.stop());
  return link;
}

async function sim(link: StationLink, intervalMs = 50) {
  const s = new StationSimulator({ port: link.port, intervalMs });
  await s.connect();
  cleanup.push(() => s.disconnect());
  return s;
}

describe('StationLink', () => {
  it('emits decoded reports, goes up and ACKs every report', async () => {
    const link = await startLink();
    const reports: Record<string, number | string>[] = [];
    const states: LinkState[] = [];
    link.on('report', (r) => reports.push(r));
    link.on('state', (s) => states.push(s));
    const s = await sim(link);
    await until(() => reports.length >= 2 && s.acks >= 2);
    expect(reports[0].soc).toBe(60);
    expect(states).toEqual(['up']);
    expect(link.state).toBe('up');
  });

  it('drops frames with a bad CRC', async () => {
    const link = await startLink();
    const reports: unknown[] = [];
    link.on('report', (r) => reports.push(r));
    const raw = buildReport({ [KEY.soc]: 50 });
    raw[raw.length - 1] ^= 0xff;
    const c = net.createConnection({ port: link.port, host: '127.0.0.1' });
    cleanup.push(() => c.destroy());
    await new Promise((r) => c.once('connect', r));
    c.write(raw);
    await until(() => link.stats.badFrames === 1);
    expect(reports).toHaveLength(0);
  });

  it('goes down when reports stop for linkTimeoutMs', async () => {
    const link = await startLink({ linkTimeoutMs: 200 });
    const states: LinkState[] = [];
    link.on('state', (s) => states.push(s));
    const s = await sim(link);
    await until(() => link.state === 'up');
    s.disconnect();
    await until(() => link.state === 'down', 2000);
    expect(states).toEqual(['up', 'down']);
  });

  it('keeps the default link timeout when options pass undefined explicitly', async () => {
    const link = await startLink({ linkTimeoutMs: undefined, sendAck: undefined, now: undefined });
    const states: LinkState[] = [];
    link.on('state', (st) => states.push(st));
    const s = await sim(link, 50);
    await until(() => s.acks >= 5);
    expect(states).toEqual(['up']);
  });

  it('rejects connections outside the allowed prefix', async () => {
    const link = await startLink({ allowedPrefix: '192.168.8.' });
    const c = net.createConnection({ port: link.port, host: '127.0.0.1' });
    cleanup.push(() => c.destroy());
    await new Promise((r) => c.once('close', r));
    expect(link.stats.rejected).toBe(1);
  });

  it('send() throws offline without a station and delivers commands with one', async () => {
    const link = await startLink();
    expect(() => link.send(buildWriteCommand(KEY.led, 1))).toThrow(StationOfflineError);
    const s = await sim(link);
    await until(() => link.state === 'up');
    link.send(buildWriteCommand(KEY.led, 1));
    await until(() => s.state[KEY.led] === 1);
  });

  it('keeps only the newest connection', async () => {
    const link = await startLink();
    const first = await sim(link);
    await until(() => link.stats.reports > 0);
    const second = await sim(link);
    await until(() => link.stats.connections === 2);
    link.send(buildWriteCommand(KEY.led, 3));
    await until(() => second.state[KEY.led] === 3);
    expect(first.state[KEY.led]).toBe(0);
  });
});
