import { EventEmitter } from 'node:events';
import { ID_BY_KEY, parseFrame } from '../../shared/protocol.ts';
import type { Snapshot } from '../../shared/telemetry.ts';
import { StationOfflineError, type LinkState } from './station-link.ts';

export function makeSnapshot(ts: number, o: Partial<Snapshot> = {}): Snapshot {
  const s: Snapshot = {
    ts,
    soc: 60,
    inW: 85,
    outW: 85,
    acInW: 85,
    acOutW: 85,
    solarW: 0,
    dcW: 0,
    usbW: 0,
    acV: 233,
    tempC: 30,
    acOn: true,
    dcOn: false,
    usbOn: false,
    led: 0,
    ecoMode: false,
    chargeLimit: 60,
    dischargeLimit: 0,
    stationRemainingMin: 3600,
    faults: { bms: 0, pcs: 0, pv: 0 },
    ...o,
    registers: {},
  };
  s.registers = {
    soc: s.soc,
    acOn: s.acOn ? 1 : 0,
    dcOn: s.dcOn ? 1 : 0,
    usbOn: s.usbOn ? 1 : 0,
    led: s.led,
    ecoMode: s.ecoMode ? 1 : 0,
    chargeLimit: s.chargeLimit ?? 60,
    dischargeLimit: s.dischargeLimit ?? 0,
    chargePowerW: 1200,
    ...o.registers,
  };
  return s;
}

/** In-memory stand-in for StationLink; with autoConfirm it echoes every command in the next report. */
export class FakeLink extends EventEmitter<{ report: [Record<string, number | string>, number]; state: [LinkState] }> {
  state: LinkState = 'up';
  sent: Uint8Array[] = [];
  autoConfirm = true;

  send(frame: Uint8Array): void {
    if (this.state !== 'up') throw new StationOfflineError();
    this.sent.push(frame);
    if (!this.autoConfirm) return;
    const [[key, v]] = [...parseFrame(frame)!.records];
    queueMicrotask(() => this.emit('report', { [ID_BY_KEY[key]]: v[0] | (v[1] << 8) }, Date.now()));
  }
}

export async function until(fn: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error('until(): timeout');
    await new Promise((r) => setTimeout(r, 20));
  }
}
