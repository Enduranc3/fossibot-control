import net from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ACK_FRAME,
  FrameAssembler,
  KEY,
  buildWriteCommand,
  decodeRegisters,
  parseFrame,
  verifyCrc,
} from '../shared/protocol.ts';
import { StationSimulator } from './station-sim.ts';

const closers: (() => void)[] = [];
afterEach(() => closers.splice(0).forEach((c) => c()));

/** A bare TCP server standing in for the hub. */
async function hubStub() {
  const reports: Record<string, number | string>[] = [];
  let socket: net.Socket | null = null;
  const server = net.createServer((s) => {
    socket = s;
    const asm = new FrameAssembler();
    s.on('data', (d: Buffer) => {
      for (const raw of asm.push(new Uint8Array(d))) {
        if (verifyCrc(raw)) reports.push(decodeRegisters(parseFrame(raw)!));
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  closers.push(() => server.close());
  const port = (server.address() as net.AddressInfo).port;
  return { port, reports, send: (b: Uint8Array) => socket!.write(b) };
}

const until = async (fn: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 20));
  }
};

describe('StationSimulator', () => {
  it('sends valid reports with the real-station defaults', async () => {
    const hub = await hubStub();
    const sim = new StationSimulator({ port: hub.port, intervalMs: 50 });
    closers.push(() => sim.disconnect());
    await sim.connect();
    await until(() => hub.reports.length >= 2);
    expect(hub.reports[0]).toMatchObject({ soc: 60, acOn: 1, acInputW: 85, totalOutputW: 85, acOutputVoltage: 233 });
  });

  it('applies write commands and counts ACKs', async () => {
    const hub = await hubStub();
    const sim = new StationSimulator({ port: hub.port, intervalMs: 50 });
    closers.push(() => sim.disconnect());
    await sim.connect();
    await until(() => hub.reports.length >= 1);
    hub.send(ACK_FRAME);
    hub.send(buildWriteCommand(KEY.led, 2));
    await until(() => hub.reports.some((r) => r.led === 2));
    expect(sim.writes).toContainEqual({ key: KEY.led, value: 2 });
    expect(sim.acks).toBe(1);
  });

  it('models a grid outage: no AC input, output stays, SoC falls', async () => {
    const hub = await hubStub();
    const sim = new StationSimulator({ port: hub.port, intervalMs: 50 });
    closers.push(() => sim.disconnect());
    await sim.connect();
    sim.setGrid(false);
    await until(() => hub.reports.some((r) => r.acInputW === 0));
    const last = hub.reports[hub.reports.length - 1];
    expect(last.totalInputW).toBe(0);
    expect(last.totalOutputW).toBe(85);
  });

  it('ignores commands when asked to', async () => {
    const hub = await hubStub();
    const sim = new StationSimulator({ port: hub.port, intervalMs: 50 });
    sim.ignoreCommands = true;
    closers.push(() => sim.disconnect());
    await sim.connect();
    await until(() => hub.reports.length >= 1);
    hub.send(buildWriteCommand(KEY.led, 1));
    await until(() => hub.reports.length >= 4);
    expect(sim.state[KEY.led]).toBe(0);
  });
});
