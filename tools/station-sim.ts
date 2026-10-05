// Fossibot F1800 simulator: connects to a hub like the real station (TCP client), sends a report
// every interval, applies write commands. Used by tests and for running the hub without hardware.
import net from 'node:net';
import { parseArgs } from 'node:util';
import { FrameAssembler, FrameType, KEY, buildReport, parseFrame, verifyCrc } from '../shared/protocol.ts';

/** Raw register values as reported by the real station on 2026-10-05. */
export const DEFAULT_STATE: Record<number, number> = {
  [KEY.soc]: 60,
  [KEY.batteryTempMax]: 30,
  [KEY.remainingMinutes]: 3600,
  [KEY.chargeState]: 0,
  [KEY.pcsVersion]: 0x1016,
  [KEY.acInputW]: 85,
  [KEY.acOutputW]: 85,
  [KEY.acOutputVoltage]: 2330,
  [KEY.acOutputFrequency]: 500,
  [KEY.solarInputW]: 0,
  [KEY.totalInputW]: 85,
  [KEY.totalOutputW]: 85,
  [KEY.dcOutputW]: 0,
  [KEY.usbOutputW]: 0,
  [KEY.led]: 0,
  [KEY.acOn]: 1,
  [KEY.dcOn]: 0,
  [KEY.usbOn]: 0,
  [KEY.chargePowerW]: 1200,
  [KEY.acRestoreOnPower]: 1,
  [KEY.screenTimeout]: 1,
  [KEY.acStandbyLegacy]: 2,
  [KEY.ecoMode]: 0,
  [KEY.solarEnergyKwh]: 0,
  [KEY.chargeLimit]: 60,
  [KEY.dischargeLimit]: 0,
  [KEY.keySoundOff]: 0,
  [KEY.screenBrightness]: 15,
  [KEY.dcChargeCurrent]: 15,
  [KEY.scheduledCharge]: 1,
  [KEY.scheduledDischarge]: 0,
  [KEY.dcStandby]: 3,
  [KEY.usbStandby]: 3,
  [KEY.acStandby]: 4,
};

const CAPACITY_WH = 1024;

export interface SimOptions {
  port: number;
  host?: string;
  intervalMs?: number;
}

export class StationSimulator {
  state: Record<number, number> = { ...DEFAULT_STATE };
  writes: { key: number; value: number }[] = [];
  acks = 0;
  ignoreCommands = false;
  acLoadW = 85;
  dcLoadW = 36;
  usbLoadW = 12;
  grid = true;
  private socFloat = DEFAULT_STATE[KEY.soc];
  private readonly opts: Required<SimOptions>;
  private socket: net.Socket | null = null;
  private timer: ReturnType<typeof setInterval> | undefined;
  private readonly assembler = new FrameAssembler();

  constructor(opts: SimOptions) {
    this.opts = { host: '127.0.0.1', intervalMs: 1000, ...opts };
  }

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const s = net.createConnection({ host: this.opts.host, port: this.opts.port }, () => {
        s.off('error', reject);
        this.socket = s;
        this.timer = setInterval(() => this.tick(), this.opts.intervalMs);
        this.tick();
        resolve();
      });
      s.once('error', reject);
      s.on('data', (d: Buffer) => this.onData(new Uint8Array(d)));
      s.on('close', () => this.stopTimer());
      s.on('error', () => s.destroy());
    });
  }

  disconnect(): void {
    this.stopTimer();
    this.socket?.destroy();
    this.socket = null;
  }

  set(key: number, value: number): void {
    this.state[key] = value;
    if (key === KEY.soc) this.socFloat = value;
  }

  setGrid(on: boolean): void {
    this.grid = on;
    this.recompute();
  }

  sendReport(): void {
    this.socket?.write(buildReport(this.state));
  }

  private tick() {
    this.recompute();
    if (!this.grid && this.state[KEY.totalOutputW] > 0) {
      const wh = (this.state[KEY.totalOutputW] * this.opts.intervalMs) / 3_600_000;
      this.socFloat = Math.max(0, this.socFloat - (wh / CAPACITY_WH) * 100);
      this.state[KEY.soc] = Math.round(this.socFloat);
    }
    this.sendReport();
  }

  private recompute() {
    const s = this.state;
    s[KEY.acOutputW] = s[KEY.acOn] ? this.acLoadW : 0;
    s[KEY.dcOutputW] = s[KEY.dcOn] ? this.dcLoadW : 0;
    s[KEY.usbOutputW] = s[KEY.usbOn] ? this.usbLoadW * 10 : 0; // 0.1 W units
    s[KEY.totalOutputW] = s[KEY.acOutputW] + s[KEY.dcOutputW] + (s[KEY.usbOn] ? this.usbLoadW : 0);
    s[KEY.acInputW] = this.grid ? s[KEY.totalOutputW] : 0;
    s[KEY.totalInputW] = s[KEY.acInputW] + s[KEY.solarInputW];
  }

  private onData(chunk: Uint8Array) {
    for (const raw of this.assembler.push(chunk)) {
      const f = parseFrame(raw);
      if (!f) continue;
      if (f.type === FrameType.Ack) {
        this.acks++;
        continue;
      }
      if (f.type !== FrameType.Write || !verifyCrc(raw) || this.ignoreCommands) continue;
      for (const [key, v] of f.records) {
        const value = v[0] | (v[1] << 8);
        this.writes.push({ key, value });
        this.state[key] = value;
      }
    }
  }

  private stopTimer() {
    clearInterval(this.timer);
    this.timer = undefined;
  }
}

if (import.meta.main) {
  const { values } = parseArgs({
    options: {
      host: { type: 'string', default: '127.0.0.1' },
      port: { type: 'string', default: '8058' },
      interval: { type: 'string', default: '1000' },
      scenario: { type: 'string', default: 'normal' },
    },
  });
  const sim = new StationSimulator({ host: values.host, port: Number(values.port), intervalMs: Number(values.interval) });
  await sim.connect();
  console.log(`[sim] connected to ${values.host}:${values.port}, scenario=${values.scenario}`);
  if (values.scenario === 'outage') {
    setTimeout(() => (sim.setGrid(false), console.log('[sim] grid OFF')), 30_000);
    setTimeout(() => (sim.setGrid(true), console.log('[sim] grid ON')), 90_000);
  }
  process.on('SIGINT', () => (sim.disconnect(), process.exit(0)));
}
