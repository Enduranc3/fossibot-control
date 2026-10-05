import type { LiveMessage } from './types.ts';

export interface SocketLike {
  onopen: ((ev: unknown) => void) | null;
  onclose: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  close(): void;
}

export interface LiveClientOptions {
  url: string;
  onMessage(m: LiveMessage): void;
  onStatus(s: 'connecting' | 'open' | 'closed'): void;
  /** The socket closed before opening: the session may have expired. */
  onRejected?(): void;
  createSocket?(url: string): SocketLike;
  backoffMs?: readonly number[];
  /** Telemetry arrives every second; silence this long means the link is dead. */
  staleMs?: number;
}

const DEFAULT_BACKOFF = [1000, 2000, 5000, 10_000, 30_000] as const;

/** WebSocket to /api/live with reconnection, backoff and a dead-link timer. */
export class LiveClient {
  private readonly url: string;
  private readonly onMessage: LiveClientOptions['onMessage'];
  private readonly onStatus: LiveClientOptions['onStatus'];
  private readonly onRejected: () => void;
  private readonly createSocket: (url: string) => SocketLike;
  private readonly backoffMs: readonly number[];
  private readonly staleMs: number;
  private socket: SocketLike | null = null;
  private attempt = 0;
  private stopped = true;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private staleTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(opts: LiveClientOptions) {
    this.url = opts.url;
    this.onMessage = opts.onMessage;
    this.onStatus = opts.onStatus;
    this.onRejected = opts.onRejected ?? (() => {});
    this.createSocket = opts.createSocket ?? ((u) => new WebSocket(u) as unknown as SocketLike);
    this.backoffMs = opts.backoffMs ?? DEFAULT_BACKOFF;
    this.staleMs = opts.staleMs ?? 15_000;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.retryTimer);
    clearTimeout(this.staleTimer);
    const s = this.socket;
    this.socket = null;
    s?.close();
    this.onStatus('closed');
  }

  /** Reconnect right away, e.g. when the app comes back to the foreground. */
  kick(): void {
    if (this.stopped || this.socket) return;
    clearTimeout(this.retryTimer);
    this.connect();
  }

  private connect(): void {
    this.onStatus('connecting');
    let opened = false;
    const s = this.createSocket(this.url);
    this.socket = s;
    s.onopen = () => {
      opened = true;
      this.attempt = 0;
      this.onStatus('open');
      this.armStale();
    };
    s.onmessage = (ev) => {
      this.armStale();
      if (typeof ev.data !== 'string') return;
      let m: LiveMessage;
      try {
        m = JSON.parse(ev.data) as LiveMessage;
      } catch {
        return;
      }
      this.onMessage(m);
    };
    s.onerror = () => {};
    s.onclose = () => {
      if (this.socket !== s) return;
      this.socket = null;
      clearTimeout(this.staleTimer);
      if (this.stopped) return;
      this.onStatus('closed');
      if (!opened) this.onRejected();
      const delay = this.backoffMs[Math.min(this.attempt, this.backoffMs.length - 1)];
      this.attempt++;
      this.retryTimer = setTimeout(() => this.connect(), delay);
    };
  }

  private armStale(): void {
    clearTimeout(this.staleTimer);
    this.staleTimer = setTimeout(() => this.socket?.close(), this.staleMs);
  }
}

export function liveUrl(loc: { protocol: string; host: string }): string {
  return `${loc.protocol === 'https:' ? 'wss:' : 'ws:'}//${loc.host}/api/live`;
}
