import type { LedMode } from './protocol.ts';

/** One decoded station report, flattened for the hub and the web app. */
export interface Snapshot {
  /** Unix milliseconds when the hub received the report. */
  ts: number;
  soc: number;
  inW: number;
  outW: number;
  acInW: number;
  acOutW: number;
  solarW: number;
  dcW: number;
  usbW: number;
  acV: number | null;
  tempC: number | null;
  acOn: boolean;
  dcOn: boolean;
  usbOn: boolean;
  led: LedMode;
  ecoMode: boolean;
  chargeLimit: number | null;
  dischargeLimit: number | null;
  stationRemainingMin: number | null;
  faults: { bms: number; pcs: number; pv: number };
  /** Every decoded register by id (see REGISTERS in protocol.ts). */
  registers: Record<string, number | string>;
}

const num = (r: Record<string, number | string>, id: string): number | null =>
  typeof r[id] === 'number' ? (r[id] as number) : null;

export function toSnapshot(registers: Record<string, number | string>, ts: number): Snapshot {
  return {
    ts,
    soc: num(registers, 'soc') ?? 0,
    inW: num(registers, 'totalInputW') ?? 0,
    outW: num(registers, 'totalOutputW') ?? 0,
    acInW: num(registers, 'acInputW') ?? 0,
    acOutW: num(registers, 'acOutputW') ?? 0,
    solarW: num(registers, 'solarInputW') ?? 0,
    dcW: num(registers, 'dcOutputW') ?? 0,
    usbW: num(registers, 'usbOutputW') ?? 0,
    acV: num(registers, 'acOutputVoltage'),
    tempC: num(registers, 'batteryTempMax'),
    acOn: num(registers, 'acOn') === 1,
    dcOn: num(registers, 'dcOn') === 1,
    usbOn: num(registers, 'usbOn') === 1,
    led: (num(registers, 'led') ?? 0) as LedMode,
    ecoMode: num(registers, 'ecoMode') === 1,
    chargeLimit: num(registers, 'chargeLimit'),
    dischargeLimit: num(registers, 'dischargeLimit'),
    stationRemainingMin: num(registers, 'remainingMinutes'),
    faults: {
      bms: num(registers, 'bmsFault') ?? 0,
      pcs: num(registers, 'pcsFault') ?? 0,
      pv: num(registers, 'pvFault') ?? 0,
    },
    registers,
  };
}
