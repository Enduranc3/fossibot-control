import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LiveClient, liveUrl, type SocketLike } from './live.ts';

class FakeSocket implements SocketLike {
  static all: FakeSocket[] = [];
  onopen: ((ev: unknown) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  closed = false;
  url: string;
  constructor(url: string) {
    this.url = url;
    FakeSocket.all.push(this);
  }
  open() {
    this.onopen?.({});
  }
  message(data: unknown) {
    this.onmessage?.({ data });
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    this.onclose?.({});
  }
}

beforeEach(() => {
  vi.useFakeTimers();
  FakeSocket.all = [];
});
afterEach(() => vi.useRealTimers());

function client(extra: Partial<ConstructorParameters<typeof LiveClient>[0]> = {}) {
  const messages: unknown[] = [];
  const statuses: string[] = [];
  const rejected = vi.fn();
  const c = new LiveClient({
    url: 'wss://hub/api/live',
    onMessage: (m) => messages.push(m),
    onStatus: (s) => statuses.push(s),
    onRejected: rejected,
    createSocket: (u) => new FakeSocket(u),
    backoffMs: [1000, 5000],
    staleMs: 15_000,
    ...extra,
  });
  return { c, messages, statuses, rejected };
}

describe('LiveClient', () => {
  it('connects, reports status and parses messages, ignoring junk', () => {
    const { c, messages, statuses } = client();
    c.start();
    FakeSocket.all[0].open();
    FakeSocket.all[0].message('{"type":"link","state":"up"}');
    FakeSocket.all[0].message('not json');
    FakeSocket.all[0].message(new ArrayBuffer(2));
    expect(statuses).toEqual(['connecting', 'open']);
    expect(messages).toEqual([{ type: 'link', state: 'up' }]);
  });

  it('reports a rejected handshake and retries with growing backoff', () => {
    const { c, rejected } = client();
    c.start();
    FakeSocket.all[0].close(); // closed before open
    expect(rejected).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(999);
    expect(FakeSocket.all).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(FakeSocket.all).toHaveLength(2);
    FakeSocket.all[1].close();
    vi.advanceTimersByTime(4999);
    expect(FakeSocket.all).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(FakeSocket.all).toHaveLength(3);
  });

  it('resets the backoff after a successful open and does not flag an open-then-closed socket as rejected', () => {
    const { c, rejected } = client();
    c.start();
    FakeSocket.all[0].close();
    vi.advanceTimersByTime(1000);
    FakeSocket.all[1].open();
    FakeSocket.all[1].close();
    expect(rejected).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1000);
    expect(FakeSocket.all).toHaveLength(3);
  });

  it('closes a silent connection after staleMs and reconnects', () => {
    const { c } = client();
    c.start();
    FakeSocket.all[0].open();
    vi.advanceTimersByTime(15_000);
    expect(FakeSocket.all[0].closed).toBe(true);
    vi.advanceTimersByTime(1000);
    expect(FakeSocket.all).toHaveLength(2);
  });

  it('stays stopped after stop() and reconnects at once on kick()', () => {
    const { c, statuses } = client();
    c.start();
    FakeSocket.all[0].open();
    c.stop();
    vi.advanceTimersByTime(60_000);
    expect(FakeSocket.all).toHaveLength(1);
    expect(statuses.at(-1)).toBe('closed');
    const second = client();
    second.c.start();
    FakeSocket.all[1].close();
    second.c.kick();
    expect(FakeSocket.all).toHaveLength(3);
  });

  it('keeps defaults when options pass undefined', () => {
    const { c } = client({ backoffMs: undefined, staleMs: undefined });
    c.start();
    FakeSocket.all[0].close();
    vi.advanceTimersByTime(1000);
    expect(FakeSocket.all).toHaveLength(2);
  });

  it('builds the socket URL from the page location', () => {
    expect(liveUrl({ protocol: 'https:', host: 'fossibot-hub.x.ts.net' })).toBe('wss://fossibot-hub.x.ts.net/api/live');
    expect(liveUrl({ protocol: 'http:', host: 'localhost:5173' })).toBe('ws://localhost:5173/api/live');
  });
});
