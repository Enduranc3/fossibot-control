import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { KEY, parseFrame } from '../../shared/protocol.ts';
import { CommandError, CommandQueue } from './command-queue.ts';
import { FakeLink } from './test-helpers.ts';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

const keyOf = (f: Uint8Array) => [...parseFrame(f)!.records.keys()][0];

describe('CommandQueue', () => {
  it('resolves when a report shows the requested value', async () => {
    const link = new FakeLink();
    const q = new CommandQueue(link);
    await q.execute('acOn', 0);
    expect(link.sent).toHaveLength(1);
    expect(keyOf(link.sent[0])).toBe(KEY.acOn);
  });

  it('retries once after confirmMs, then succeeds', async () => {
    const link = new FakeLink();
    link.autoConfirm = false;
    const q = new CommandQueue(link, { confirmMs: 3000 });
    const p = q.execute('led', 1);
    await vi.advanceTimersByTimeAsync(3000);
    expect(link.sent).toHaveLength(2);
    link.emit('report', { led: 1 }, Date.now());
    await expect(p).resolves.toBeUndefined();
  });

  it('fails with not_confirmed after the retry also times out', async () => {
    const link = new FakeLink();
    link.autoConfirm = false;
    const q = new CommandQueue(link, { confirmMs: 3000 });
    const p = q.execute('led', 1).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(6000);
    const err = (await p) as CommandError;
    expect(err).toBeInstanceOf(CommandError);
    expect(err.code).toBe('not_confirmed');
    expect(link.sent).toHaveLength(2);
  });

  it('ignores reports with a different value', async () => {
    const link = new FakeLink();
    link.autoConfirm = false;
    const q = new CommandQueue(link, { confirmMs: 3000, retries: 0 });
    const p = q.execute('led', 2).catch((e: unknown) => e);
    link.emit('report', { led: 1 }, Date.now());
    await vi.advanceTimersByTimeAsync(3000);
    expect(((await p) as CommandError).code).toBe('not_confirmed');
  });

  it('fails fast when the station is offline and for invalid commands', async () => {
    const link = new FakeLink();
    link.state = 'down';
    const q = new CommandQueue(link);
    await expect(q.execute('acOn', 1)).rejects.toMatchObject({ code: 'station_offline' });
    await expect(q.execute('soc', 1)).rejects.toMatchObject({ code: 'invalid' });
    expect(link.sent).toHaveLength(0);
  });

  it('runs commands one at a time', async () => {
    const link = new FakeLink();
    link.autoConfirm = false;
    const q = new CommandQueue(link, { confirmMs: 3000 });
    const a = q.execute('acOn', 0);
    const b = q.execute('dcOn', 1);
    await vi.advanceTimersByTimeAsync(10);
    expect(link.sent).toHaveLength(1);
    link.emit('report', { acOn: 0 }, Date.now());
    await a;
    await vi.advanceTimersByTimeAsync(10);
    expect(link.sent).toHaveLength(2);
    link.emit('report', { dcOn: 1 }, Date.now());
    await b;
  });

  it('remembers requested values for requestedTtlMs', async () => {
    const link = new FakeLink();
    const q = new CommandQueue(link, { requestedTtlMs: 10_000 });
    await q.execute('usbOn', 1);
    expect(q.wasRequested('usbOn', 1)).toBe(true);
    expect(q.wasRequested('usbOn', 0)).toBe(false);
    await vi.advanceTimersByTimeAsync(10_001);
    expect(q.wasRequested('usbOn', 1)).toBe(false);
  });
});
