import type { PluginListenerHandle } from '@capacitor/core';
import { CLOUD_WS, type FossibotCloud } from './cloud-api';
import { errorText, type Transport, type TransportSink } from './fossibot-driver';
import { FossibotNet } from './native';
import { ACK_FRAME, FrameType, KEY, bytesToHex, crc16modbus, hexToBytes, parseFrame } from './protocol';

export const LOCAL_PORT = 8058;

// ---------------------------------------------------------------- local: station Wi-Fi

/**
 * Offline mode of the official app: the phone joins the FOSS_<SN> hotspot, listens on TCP :8058,
 * and the station connects to it. Every received packet is answered with ACK_FRAME, as the app does.
 */
export class LocalTcpTransport implements Transport {
  readonly mode = 'local';
  readonly framed = false;
  private handles: PluginListenerHandle[] = [];
  private sessionId: string | null = null;
  private stopped = false;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;

  async start(sink: TransportSink): Promise<void> {
    this.stopped = false;
    this.handles = await Promise.all([
      FossibotNet.addListener('serverState', async ({ state, error }) => {
        if (state === 'listening') {
          const { interfaces } = await FossibotNet.getNetworkInfo();
          const ips = interfaces.map((i) => `${i.name} ${i.address}`).join(', ') || 'немає IP';
          sink.state('waiting', `Слухаю :${LOCAL_PORT} (${ips}). Чекаю на станцію…`);
        } else if (state === 'failed') {
          sink.state('error', `TCP-сервер: ${error ?? 'помилка'}; перезапуск через 3 с`);
          this.scheduleRestart(sink);
        } else if (state === 'waiting') {
          sink.log('info', `TCP-сервер чекає мережу: ${error ?? ''}`);
        }
      }),
      FossibotNet.addListener('clientConnected', ({ sessionId, remote }) => {
        this.sessionId = sessionId;
        sink.log('info', `Станція підключилась: ${remote}`);
        sink.state('connected', `Станція ${remote}`);
      }),
      FossibotNet.addListener('clientData', ({ sessionId, hex }) => {
        this.sessionId = sessionId;
        sink.data(hexToBytes(hex));
        FossibotNet.send({ hex: bytesToHex(ACK_FRAME), sessionId }).catch((e) =>
          sink.log('error', `ACK: ${errorText(e)}`),
        );
        sink.log('tx', `${bytesToHex(ACK_FRAME, ' ')}  ← ACK`);
      }),
      FossibotNet.addListener('clientDisconnected', ({ sessionId, error }) => {
        if (sessionId === this.sessionId) this.sessionId = null;
        sink.state('waiting', `Станція відключилась${error ? `: ${error}` : ''}. Чекаю повторного підключення…`);
      }),
    ]);
    await FossibotNet.startServer({ port: LOCAL_PORT });
  }

  async stop(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.retryTimer);
    await Promise.all(this.handles.map((h) => h.remove()));
    this.handles = [];
    this.sessionId = null;
    await FossibotNet.stopServer();
  }

  async send(frame: Uint8Array): Promise<void> {
    if (!this.sessionId) throw new Error('Станція ще не підключилась до телефона');
    await FossibotNet.send({ hex: bytesToHex(frame), sessionId: this.sessionId });
  }

  private scheduleRestart(sink: TransportSink) {
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => {
      if (this.stopped) return;
      FossibotNet.startServer({ port: LOCAL_PORT }).catch((e) => sink.state('error', errorText(e)));
    }, 3_000);
  }
}

// ---------------------------------------------------------------- cloud: app.fossibot.hk

export class CloudTransport implements Transport {
  readonly mode = 'cloud';
  readonly framed = true;
  private handles: PluginListenerHandle[] = [];
  private heartbeat: ReturnType<typeof setInterval> | undefined;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private retryDelay = 2_000;
  private stopped = false;
  private readonly cloud: FossibotCloud;
  readonly snCode: string;

  constructor(cloud: FossibotCloud, snCode: string) {
    this.cloud = cloud;
    this.snCode = snCode;
  }

  async start(sink: TransportSink): Promise<void> {
    this.stopped = false;
    this.handles = await Promise.all([
      FossibotNet.addListener('wsOpen', () => {
        this.retryDelay = 2_000;
        sink.state('waiting', 'Сервер підключено, чекаю дані станції…');
        clearInterval(this.heartbeat);
        // Same heartbeat as utils/socket.js: {"type":"hear","msg":<userName>} every 5 s.
        this.heartbeat = setInterval(() => {
          FossibotNet.wsSend({ text: JSON.stringify({ type: 'hear', msg: this.cloud.username }) }).catch(() => {});
        }, 5_000);
      }),
      FossibotNet.addListener('wsMessage', ({ text }) => this.onMessage(text, sink)),
      FossibotNet.addListener('wsClose', ({ code, reason }) => {
        clearInterval(this.heartbeat);
        if (this.stopped) return;
        sink.state('connecting', `З'єднання із сервером закрито (${code}${reason ? `, ${reason}` : ''}); повтор через ${this.retryDelay / 1000} с`);
        this.scheduleReconnect(sink);
      }),
    ]);
    await this.open(sink);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    clearInterval(this.heartbeat);
    clearTimeout(this.retryTimer);
    await Promise.all(this.handles.map((h) => h.remove()));
    this.handles = [];
    await FossibotNet.wsClose();
  }

  async send(frame: Uint8Array): Promise<void> {
    await this.cloud.sendCommand(this.snCode, bytesToHex(frame));
  }

  private async open(sink: TransportSink, relogin = false) {
    if (relogin || !this.cloud.token) {
      sink.log('info', 'Вхід на сервер Fossibot…');
      await this.cloud.login();
    }
    await FossibotNet.wsConnect({ url: CLOUD_WS, headers: this.cloud.wsHeaders(this.snCode) });
  }

  private onMessage(text: string, sink: TransportSink) {
    let msg: { code?: number | string; snCode?: string; data?: unknown; msg?: string };
    try {
      msg = JSON.parse(text);
    } catch {
      sink.log('info', `WS: ${text}`);
      return;
    }
    if (msg.code !== undefined) {
      const code = String(msg.code);
      if (code === '401') {
        sink.log('info', 'Сервер: 401, повторний вхід');
        FossibotNet.wsClose().catch(() => {});
        this.open(sink, true).catch((e) => sink.state('error', errorText(e)));
      } else if (code === '403') {
        sink.state('waiting', 'Сервер каже: станція офлайн');
      } else {
        sink.log('info', `WS: ${text}`);
      }
      return;
    }
    if (typeof msg.data === 'string' && /^[0-9a-f\s]+$/i.test(msg.data)) {
      if (!msg.snCode || msg.snCode === this.snCode) sink.data(hexToBytes(msg.data));
    } else {
      sink.log('info', `WS: ${text}`);
    }
  }

  private scheduleReconnect(sink: TransportSink) {
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => {
      if (this.stopped) return;
      this.open(sink).catch((e) => {
        sink.state('error', `${errorText(e)}; повтор через ${this.retryDelay / 1000} с`);
        this.scheduleReconnect(sink);
      });
    }, this.retryDelay);
    this.retryDelay = Math.min(this.retryDelay * 2, 30_000);
  }
}

// ---------------------------------------------------------------- demo (browser preview)

/** Simulated F1800 that speaks the real binary protocol, for trying the UI without a station. */
export class DemoTransport implements Transport {
  readonly mode = 'demo';
  readonly framed = false;
  private timer: ReturnType<typeof setInterval> | undefined;
  private sink: TransportSink | null = null;
  private tick = 0;
  private state: Record<number, number> = {
    [KEY.soc]: 64,
    [KEY.remainingMinutes]: 0,
    [KEY.acOn]: 1,
    [KEY.dcOn]: 0,
    [KEY.usbOn]: 1,
    [KEY.led]: 0,
    [KEY.ecoMode]: 0,
    [KEY.chargePowerW]: 900,
    [KEY.chargeLimit]: 100,
    [KEY.dischargeLimit]: 5,
    [KEY.acOutputVoltage]: 2300,
    [KEY.acOutputFrequency]: 50,
    [KEY.packVoltage]: 512,
    [KEY.batteryTempMax]: 27,
    [KEY.screenBrightness]: 80,
    [KEY.dcChargeCurrent]: 8,
  };

  async start(sink: TransportSink): Promise<void> {
    this.sink = sink;
    sink.state('waiting', 'Демо: імітація станції F1800');
    setTimeout(() => this.report(), 600);
    this.timer = setInterval(() => this.report(), 2_000);
  }

  async stop(): Promise<void> {
    clearInterval(this.timer);
    this.sink = null;
  }

  async send(frame: Uint8Array): Promise<void> {
    const f = parseFrame(frame);
    if (!f || f.type !== FrameType.Write) return;
    for (const [key, v] of f.records) this.state[key] = v[0] | (v[1] << 8);
    setTimeout(() => this.report(), 250);
  }

  private report() {
    if (!this.sink) return;
    const s = this.state;
    this.tick++;
    const solar = Math.max(0, Math.round(320 + 180 * Math.sin(this.tick / 9)));
    const ac = s[KEY.acOn] ? 140 + Math.round(40 * Math.sin(this.tick / 4)) : 0;
    const dc = s[KEY.dcOn] ? 36 : 0;
    const usb = s[KEY.usbOn] ? 12 : 0;
    const out = ac + dc + usb + (s[KEY.led] ? 3 : 0);
    const net = solar - out;
    s[KEY.soc] = Math.min(s[KEY.chargeLimit], Math.max(1, s[KEY.soc] + (net > 0 ? 0.05 : -0.05)));
    const regs: Record<number, number> = {
      ...s,
      [KEY.soc]: Math.round(s[KEY.soc]),
      [KEY.solarInputW]: solar,
      [KEY.acOutputW]: ac,
      [KEY.dcOutputW]: dc,
      [KEY.usbOutputW]: usb * 10,
      [KEY.totalInputW]: solar,
      [KEY.totalOutputW]: out,
      [KEY.remainingMinutes]:
        net > 0 ? Math.round(((100 - s[KEY.soc]) / 100) * 1024 * 60 / net) : Math.round((s[KEY.soc] / 100) * 1024 * 60 / Math.max(1, -net)),
    };
    this.sink.data(encodeReport(regs));
  }
}

function encodeReport(regs: Record<number, number>): Uint8Array {
  const keys = Object.keys(regs).map(Number);
  const len = 6 + keys.length * 6 + 2;
  const out = new Uint8Array(len);
  out.set([len & 0xff, len >> 8, FrameType.Report, 0, (len - 6) & 0xff, (len - 6) >> 8]);
  keys.forEach((k, i) => {
    const v = regs[k] >>> 0;
    out.set([k, 0, v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >> 24) & 0xff], 6 + i * 6);
  });
  const crc = crc16modbus(out.subarray(6, len - 2));
  out.set([crc >> 8, crc & 0xff], len - 2);
  return out;
}
