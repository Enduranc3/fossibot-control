import {
  FrameAssembler,
  FrameType,
  KEY,
  LedMode,
  buildWriteCommand,
  bytesToHex,
  decodeRegisters,
  parseFrame,
} from './protocol';

// ---------------------------------------------------------------- public types

export type ConnectionMode = 'local' | 'cloud' | 'demo';

export type ConnectionState =
  | 'idle'
  | 'connecting' // opening server / logging in / opening socket
  | 'waiting' // local server is listening, station has not connected yet
  | 'connected' // station/cloud link is up
  | 'stale' // link is up, but no telemetry for a while
  | 'error';

export type PowerFlow = 'charging' | 'discharging' | 'idle';

export interface StationTelemetry {
  soc: number;
  inputW: number;
  outputW: number;
  acInputW: number;
  acOutputW: number;
  solarInputW: number;
  dcOutputW: number;
  usbOutputW: number;
  flow: PowerFlow;
  /** Station's own estimate (key 3), minutes. */
  remainingMinutes: number | null;
  acOn: boolean;
  dcOn: boolean;
  usbOn: boolean;
  led: LedMode;
  ecoMode: boolean;
  chargePowerW: number | null;
  chargeLimit: number | null;
  dischargeLimit: number | null;
  acOutputVoltage: number | null;
  acOutputFrequency: number | null;
  packVoltage: number | null;
  batteryTempMax: number | null;
  faults: { bms: number; pcs: number; pv: number };
  firmwareVersion: string | null;
  updatedAt: number;
  /** Every decoded register, keyed by register id (see protocol.ts). */
  registers: Record<string, number | string>;
}

export interface PacketLogEntry {
  dir: 'tx' | 'rx' | 'info' | 'error';
  text: string;
  at: number;
}

/** A way to reach the station. Transports deliver raw bytes; the driver owns the protocol. */
export interface Transport {
  readonly mode: ConnectionMode;
  start(sink: TransportSink): Promise<void>;
  stop(): Promise<void>;
  send(frame: Uint8Array): Promise<void>;
  /** Whether each chunk is already a complete frame (cloud) or a raw TCP stream (local). */
  readonly framed: boolean;
}

export interface TransportSink {
  data(bytes: Uint8Array): void;
  state(state: ConnectionState, detail?: string): void;
  log(dir: PacketLogEntry['dir'], text: string): void;
}

interface DriverEvents {
  telemetry: StationTelemetry;
  state: { state: ConnectionState; detail?: string };
  packet: PacketLogEntry;
}

const STORAGE_KEY = 'fossibot.lastConnection';
const STALE_AFTER_MS = 30_000;

export interface SavedConnection {
  mode: ConnectionMode;
  snCode?: string;
  username?: string;
}

export function loadSavedConnection(): SavedConnection | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as SavedConnection) : null;
  } catch {
    return null;
  }
}

export function saveConnection(c: SavedConnection | null): void {
  try {
    if (c) localStorage.setItem(STORAGE_KEY, JSON.stringify(c));
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    // storage unavailable: nothing to remember
  }
}

// ---------------------------------------------------------------- driver

export class FossibotDriver {
  private transport: Transport | null = null;
  private assembler = new FrameAssembler();
  private flushTimer: ReturnType<typeof setTimeout> | undefined;
  private staleTimer: ReturnType<typeof setInterval> | undefined;
  private registers: Record<string, number | string> = {};
  private listeners: { [K in keyof DriverEvents]: Set<(e: DriverEvents[K]) => void> } = {
    telemetry: new Set(),
    state: new Set(),
    packet: new Set(),
  };

  state: ConnectionState = 'idle';
  telemetry: StationTelemetry | null = null;

  on<K extends keyof DriverEvents>(event: K, fn: (e: DriverEvents[K]) => void): () => void {
    this.listeners[event].add(fn);
    return () => this.listeners[event].delete(fn);
  }

  get mode(): ConnectionMode | null {
    return this.transport?.mode ?? null;
  }

  async connect(transport: Transport): Promise<void> {
    await this.disconnect();
    this.transport = transport;
    this.registers = {};
    this.telemetry = null;
    this.assembler.reset();

    const sink: TransportSink = {
      data: (bytes) => this.onBytes(transport, bytes),
      state: (state, detail) => this.transport === transport && this.setState(state, detail),
      log: (dir, text) => this.transport === transport && this.log(dir, text),
    };
    this.setState('connecting');
    this.staleTimer = setInterval(() => {
      if (this.state === 'connected' && this.telemetry && Date.now() - this.telemetry.updatedAt > STALE_AFTER_MS) {
        this.setState('stale', 'Немає даних понад 30 с');
      }
    }, 5_000);
    try {
      await transport.start(sink);
    } catch (e) {
      this.setState('error', errorText(e));
      throw e;
    }
  }

  async disconnect(): Promise<void> {
    const t = this.transport;
    this.transport = null;
    clearInterval(this.staleTimer);
    clearTimeout(this.flushTimer);
    if (t) {
      try {
        await t.stop();
      } catch (e) {
        this.log('error', `stop: ${errorText(e)}`);
      }
    }
    this.setState('idle');
  }

  // ---- commands

  toggleAC(on: boolean) {
    return this.write(KEY.acOn, on ? 1 : 0, { acOn: on });
  }

  toggleDC(on: boolean) {
    return this.write(KEY.dcOn, on ? 1 : 0, { dcOn: on });
  }

  toggleUSB(on: boolean) {
    return this.write(KEY.usbOn, on ? 1 : 0, { usbOn: on });
  }

  setLed(mode: LedMode) {
    return this.write(KEY.led, mode, { led: mode });
  }

  setEcoMode(eco: boolean) {
    return this.write(KEY.ecoMode, eco ? 1 : 0, { ecoMode: eco });
  }

  /** Writes any writable register by id (e.g. 'chargeLimit'). */
  setRegister(id: string, value: number) {
    const key = KEY[id];
    if (key === undefined) throw new Error(`Unknown register ${id}`);
    return this.write(key, value, {});
  }

  /** Sends arbitrary bytes (debug console). */
  async sendRaw(frame: Uint8Array): Promise<void> {
    if (!this.transport) throw new Error('Немає підключення');
    this.log('tx', `${bytesToHex(frame, ' ')}  ← вручну`);
    await this.transport.send(frame);
  }

  private async write(key: number, value: number, optimistic: Partial<StationTelemetry>): Promise<void> {
    if (!this.transport) throw new Error('Немає підключення');
    const frame = buildWriteCommand(key, value);
    this.log('tx', `${bytesToHex(frame, ' ')}  ← key ${key} = ${value}`);
    await this.transport.send(frame);
    if (this.telemetry) {
      // Show the new state immediately; the next report from the station confirms or reverts it.
      this.telemetry = { ...this.telemetry, ...optimistic };
      this.emit('telemetry', this.telemetry);
    }
  }

  // ---- incoming data

  private onBytes(transport: Transport, bytes: Uint8Array) {
    if (this.transport !== transport) return;
    this.log('rx', bytesToHex(bytes, ' '));
    if (transport.framed) {
      this.onFrame(bytes);
      return;
    }
    for (const f of this.assembler.push(bytes)) this.onFrame(f);
    clearTimeout(this.flushTimer);
    this.flushTimer = setTimeout(() => {
      const rest = this.assembler.flush();
      if (rest) this.onFrame(rest);
    }, 300);
  }

  private onFrame(raw: Uint8Array) {
    const frame = parseFrame(raw);
    if (!frame) return;
    if (frame.type === FrameType.Ack || frame.type === FrameType.Write) return;
    const regs = decodeRegisters(frame);
    if (!Object.keys(regs).length) return;
    this.registers = { ...this.registers, ...regs };
    this.telemetry = toTelemetry(this.registers);
    if (this.state !== 'connected') this.setState('connected');
    this.emit('telemetry', this.telemetry);
  }

  // ---- helpers

  private setState(state: ConnectionState, detail?: string) {
    this.state = state;
    this.emit('state', { state, detail });
    if (detail) this.log(state === 'error' ? 'error' : 'info', `${state}: ${detail}`);
  }

  private log(dir: PacketLogEntry['dir'], text: string) {
    this.emit('packet', { dir, text, at: Date.now() });
  }

  private emit<K extends keyof DriverEvents>(event: K, payload: DriverEvents[K]) {
    for (const fn of this.listeners[event]) fn(payload);
  }
}

// ---------------------------------------------------------------- mapping

const num = (r: Record<string, number | string>, id: string): number | null =>
  typeof r[id] === 'number' ? (r[id] as number) : null;

export function toTelemetry(r: Record<string, number | string>): StationTelemetry {
  const inputW = num(r, 'totalInputW') ?? 0;
  const outputW = num(r, 'totalOutputW') ?? 0;
  const net = inputW - outputW;
  const flow: PowerFlow = net > 5 ? 'charging' : net < -5 ? 'discharging' : 'idle';
  return {
    soc: num(r, 'soc') ?? 0,
    inputW,
    outputW,
    acInputW: num(r, 'acInputW') ?? 0,
    acOutputW: num(r, 'acOutputW') ?? 0,
    solarInputW: num(r, 'solarInputW') ?? 0,
    dcOutputW: num(r, 'dcOutputW') ?? 0,
    usbOutputW: num(r, 'usbOutputW') ?? 0,
    flow,
    remainingMinutes: num(r, 'remainingMinutes'),
    acOn: num(r, 'acOn') === 1,
    dcOn: num(r, 'dcOn') === 1,
    usbOn: num(r, 'usbOn') === 1,
    led: (num(r, 'led') ?? 0) as LedMode,
    ecoMode: num(r, 'ecoMode') === 1,
    chargePowerW: num(r, 'chargePowerW'),
    chargeLimit: num(r, 'chargeLimit'),
    dischargeLimit: num(r, 'dischargeLimit'),
    acOutputVoltage: num(r, 'acOutputVoltage'),
    acOutputFrequency: num(r, 'acOutputFrequency'),
    packVoltage: num(r, 'packVoltage'),
    batteryTempMax: num(r, 'batteryTempMax'),
    faults: { bms: num(r, 'bmsFault') ?? 0, pcs: num(r, 'pcsFault') ?? 0, pv: num(r, 'pvFault') ?? 0 },
    firmwareVersion: typeof r.firmwareVersion === 'string' ? r.firmwareVersion : null,
    updatedAt: Date.now(),
    registers: r,
  };
}

/**
 * Minutes until full (charging) or until the discharge limit (discharging), from our own math.
 * Used when the station's key 3 is missing.
 */
export function estimateMinutes(t: StationTelemetry, capacityWh: number): number | null {
  const net = t.inputW - t.outputW;
  if (t.flow === 'charging' && net > 0) {
    const target = t.chargeLimit ?? 100;
    return Math.max(0, Math.round((((target - t.soc) / 100) * capacityWh * 60) / net));
  }
  if (t.flow === 'discharging' && net < 0) {
    const floor = t.dischargeLimit ?? 0;
    return Math.max(0, Math.round((((t.soc - floor) / 100) * capacityWh * 60) / -net));
  }
  return null;
}

export function errorText(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === 'object' && e && 'message' in e) return String((e as { message: unknown }).message);
  return String(e);
}
