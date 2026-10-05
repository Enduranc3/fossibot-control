import { EventEmitter } from 'node:events';
import net from 'node:net';
import {
  ACK_FRAME,
  FrameAssembler,
  FrameType,
  decodeRegisters,
  parseFrame,
  verifyCrc,
} from '../../shared/protocol.ts';

export type LinkState = 'down' | 'up';

export class StationOfflineError extends Error {
  readonly code = 'station_offline';
  constructor() {
    super("Станція не на зв'язку");
  }
}

export interface StationLinkOptions {
  port: number;
  host?: string;
  /** Only accept stations whose IPv4 address starts with this, e.g. '192.168.8.'. */
  allowedPrefix?: string;
  linkTimeoutMs?: number;
  sendAck?: boolean;
  now?: () => number;
}

interface LinkEvents {
  report: [registers: Record<string, number | string>, ts: number];
  state: [state: LinkState];
}

/** TCP server the station connects to (it is the client). One active connection at a time. */
export class StationLink extends EventEmitter<LinkEvents> {
  state: LinkState = 'down';
  readonly stats = { reports: 0, badFrames: 0, connections: 0, rejected: 0 };
  private readonly opts: Required<Omit<StationLinkOptions, 'allowedPrefix'>> & { allowedPrefix?: string };
  private server: net.Server | null = null;
  private socket: net.Socket | null = null;
  private readonly assembler = new FrameAssembler();
  private watchdog: ReturnType<typeof setTimeout> | undefined;

  constructor(opts: StationLinkOptions) {
    super();
    // Explicit `undefined` from callers (e.g. an unset config value) must not override the defaults.
    this.opts = {
      ...opts,
      host: opts.host ?? '0.0.0.0',
      linkTimeoutMs: opts.linkTimeoutMs ?? 10_000,
      sendAck: opts.sendAck ?? true,
      now: opts.now ?? Date.now,
    };
  }

  get port(): number {
    const a = this.server?.address();
    return a && typeof a === 'object' ? a.port : this.opts.port;
  }

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      const server = net.createServer((s) => this.accept(s));
      server.once('error', reject);
      server.listen(this.opts.port, this.opts.host, () => {
        server.off('error', reject);
        this.server = server;
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    clearTimeout(this.watchdog);
    this.socket?.destroy();
    this.socket = null;
    const server = this.server;
    this.server = null;
    if (server) await new Promise<void>((r) => server.close(() => r()));
    this.setState('down');
  }

  send(frame: Uint8Array): void {
    if (!this.socket || this.socket.destroyed) throw new StationOfflineError();
    this.socket.write(frame);
  }

  private accept(s: net.Socket) {
    const remote = (s.remoteAddress ?? '').replace(/^::ffff:/, '');
    if (this.opts.allowedPrefix && !remote.startsWith(this.opts.allowedPrefix)) {
      this.stats.rejected++;
      s.destroy();
      return;
    }
    this.stats.connections++;
    this.socket?.destroy();
    this.socket = s;
    this.assembler.reset();
    s.setNoDelay(true);
    s.setKeepAlive(true, 10_000);
    s.on('data', (chunk: Buffer) => this.onData(s, new Uint8Array(chunk)));
    s.on('error', () => s.destroy());
    s.on('close', () => {
      if (this.socket === s) this.socket = null;
    });
  }

  private onData(s: net.Socket, chunk: Uint8Array) {
    if (s !== this.socket) return;
    for (const raw of this.assembler.push(chunk)) {
      const frame = parseFrame(raw);
      if (!frame || !verifyCrc(raw)) {
        this.stats.badFrames++;
        continue;
      }
      if (frame.type !== FrameType.Report) continue;
      this.stats.reports++;
      if (this.opts.sendAck) s.write(ACK_FRAME);
      this.armWatchdog();
      this.setState('up');
      this.emit('report', decodeRegisters(frame), this.opts.now());
    }
  }

  private armWatchdog() {
    clearTimeout(this.watchdog);
    this.watchdog = setTimeout(() => this.setState('down'), this.opts.linkTimeoutMs);
  }

  private setState(state: LinkState) {
    if (this.state === state) return;
    this.state = state;
    this.emit('state', state);
  }
}
