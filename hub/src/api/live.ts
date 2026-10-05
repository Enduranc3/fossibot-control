import type http from 'node:http';
import type { Duplex } from 'node:stream';
import WebSocket, { WebSocketServer } from 'ws';
import type { HubEvent } from '../../../shared/events.ts';
import type { Snapshot } from '../../../shared/telemetry.ts';
import type { Auth } from '../auth.ts';
import type { StateView } from '../context.ts';
import type { LinkState } from '../station-link.ts';
import { SESSION_COOKIE, originAllowed, parseCookies } from './http.ts';

export type LiveMessage =
  | { type: 'hello'; state: StateView }
  | { type: 'telemetry'; snapshot: Snapshot }
  | { type: 'link'; state: LinkState }
  | { type: 'grid'; present: boolean | null; sinceSec: number | null }
  | { type: 'event'; event: HubEvent };

const reject = (socket: Duplex, status: number, text: string) => {
  socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
};

/** Server → client push channel at /api/live (telemetry 1/s, link, grid, events). */
export class LiveHub {
  // The channel is server → client only; clients never need to send more than a close frame.
  private readonly wss = new WebSocketServer({ noServer: true, maxPayload: 4096 });
  private readonly alive = new WeakMap<WebSocket, boolean>();
  private readonly pinger: ReturnType<typeof setInterval>;

  constructor(server: http.Server, opts: { auth: Auth; allowedOrigins: string[]; hello(): StateView }) {
    server.on('upgrade', (req, socket, head) => {
      socket.on('error', () => socket.destroy());
      try {
        if (new URL(req.url ?? '/', 'http://hub').pathname !== '/api/live') return reject(socket, 404, 'Not Found');
        if (!originAllowed(req, opts.allowedOrigins)) return reject(socket, 403, 'Forbidden');
        const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
        if (!opts.auth.verify(token)) return reject(socket, 401, 'Unauthorized');
        this.wss.handleUpgrade(req, socket, head, (ws) => {
          this.alive.set(ws, true);
          ws.on('error', () => ws.terminate()); // protocol errors from a client must not crash the hub
          ws.on('pong', () => this.alive.set(ws, true));
          try {
            ws.send(JSON.stringify({ type: 'hello', state: opts.hello() } satisfies LiveMessage));
          } catch {
            ws.close(1011, 'state unavailable');
          }
        });
      } catch {
        // Anything malformed (bad URL, headers) must never take the process down: this port faces the internet.
        reject(socket, 400, 'Bad Request');
      }
    });
    this.pinger = setInterval(() => {
      for (const ws of this.wss.clients) {
        if (!this.alive.get(ws)) {
          ws.terminate();
          continue;
        }
        this.alive.set(ws, false);
        ws.ping();
      }
    }, 30_000);
    this.pinger.unref();
  }

  broadcast(msg: LiveMessage): void {
    const data = JSON.stringify(msg);
    for (const ws of this.wss.clients) if (ws.readyState === ws.OPEN) ws.send(data);
  }

  clientCount(): number {
    return this.wss.clients.size;
  }

  close(): void {
    clearInterval(this.pinger);
    for (const ws of this.wss.clients) ws.terminate();
    this.wss.close();
  }
}
