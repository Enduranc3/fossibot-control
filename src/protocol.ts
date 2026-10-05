// Fossibot F1800 / F300 binary protocol (see PROTOCOL.md).
//
// Frame:  LEN(u16 LE) TYPE(u16 LE) PLEN(u16 LE, = LEN-6)  { KEY(u16 LE) VAL(4 bytes LE) }*  CRC(2)
// CRC:    CRC-16/MODBUS over the record bytes, written big-endian (high byte first).

export const FrameType = {
  Report: 0x000b,
  Write: 0x000c,
  Ack: 0x001f,
} as const;

/** Bytes the original app sends back after every packet received from the station. */
export const ACK_FRAME = hexToBytes('0a001f00040004001f00');

export type DataType = 'u8' | 'bool' | 'i8' | 'u16' | 'i16' | 'i32' | 'u32' | 'ver32' | 'hex16';

export interface RegisterDef {
  key: number;
  id: string;
  type: DataType;
  /** Multiply the raw value by this to get the unit value. */
  scale?: number;
  unit?: string;
  writable?: boolean;
}

// Key numbers and types come from the register table in utils/power-hook.js.
export const REGISTERS: readonly RegisterDef[] = [
  { key: 1, id: 'soc', type: 'u8', unit: '%' },
  { key: 2, id: 'batteryTempMax', type: 'i8', unit: '°C' },
  { key: 3, id: 'remainingMinutes', type: 'u16', unit: 'min' },
  { key: 4, id: 'chargeState', type: 'u8' },
  { key: 5, id: 'bmsVersion', type: 'ver32' },
  { key: 6, id: 'batteryTempMin', type: 'i16', unit: '°C' },
  { key: 7, id: 'bmsMosTemp', type: 'i16', unit: '°C' },
  { key: 8, id: 'packVoltage', type: 'u16', scale: 0.1, unit: 'V' },
  { key: 9, id: 'batteryCurrent', type: 'i32', scale: 0.001, unit: 'A' },
  { key: 10, id: 'busVoltage', type: 'u16', scale: 0.1, unit: 'V' },
  { key: 11, id: 'balanceState', type: 'u32' },
  { key: 12, id: 'bmsFault', type: 'u32' },
  { key: 18, id: 'pcsVersion', type: 'hex16' },
  { key: 19, id: 'acInputW', type: 'u16', unit: 'W' },
  { key: 20, id: 'acOutputW', type: 'u16', unit: 'W' },
  { key: 21, id: 'acOutputVoltage', type: 'u16', scale: 0.1, unit: 'V' },
  { key: 22, id: 'acOutputFrequency', type: 'u16', scale: 0.1, unit: 'Hz' },
  { key: 23, id: 'solarInputW', type: 'u16', unit: 'W' },
  { key: 24, id: 'inverterTemp', type: 'i16', unit: '°C' },
  { key: 25, id: 'mosTemp', type: 'i16', unit: '°C' },
  { key: 26, id: 'pcsFault', type: 'u32' },
  { key: 27, id: 'pvVoltage', type: 'u16', scale: 0.1, unit: 'V' },
  { key: 28, id: 'pvCurrent', type: 'i32', scale: 0.001, unit: 'A' },
  { key: 29, id: 'pvMode', type: 'u8' },
  { key: 30, id: 'pvFault', type: 'u32' },
  { key: 34, id: 'totalInputW', type: 'u16', unit: 'W' },
  { key: 35, id: 'totalOutputW', type: 'u16', unit: 'W' },
  { key: 36, id: 'dcOutputW', type: 'u16', unit: 'W' },
  { key: 37, id: 'usbOutputW', type: 'u16', scale: 0.1, unit: 'W' },
  { key: 38, id: 'led', type: 'u8', writable: true },
  { key: 39, id: 'acOn', type: 'bool', writable: true },
  { key: 40, id: 'dcOn', type: 'bool', writable: true },
  { key: 41, id: 'usbOn', type: 'bool', writable: true },
  { key: 42, id: 'chargePowerW', type: 'u16', unit: 'W', writable: true },
  { key: 43, id: 'acRestoreOnPower', type: 'u8', writable: true },
  { key: 44, id: 'screenTimeout', type: 'u8', writable: true },
  { key: 45, id: 'acStandbyLegacy', type: 'u8', writable: true },
  { key: 46, id: 'ecoMode', type: 'bool', writable: true },
  { key: 47, id: 'firmwareVersion', type: 'ver32' },
  { key: 48, id: 'solarEnergyKwh', type: 'u16', unit: 'kWh' },
  { key: 49, id: 'chargeLimit', type: 'u8', unit: '%', writable: true },
  { key: 50, id: 'dischargeLimit', type: 'u8', unit: '%', writable: true },
  { key: 51, id: 'keySoundOff', type: 'u8', writable: true },
  { key: 52, id: 'screenBrightness', type: 'u8', unit: '%', writable: true },
  { key: 53, id: 'dcChargeCurrent', type: 'u8', unit: 'A', writable: true },
  { key: 54, id: 'scheduledCharge', type: 'u8' },
  { key: 55, id: 'scheduledDischarge', type: 'u8' },
  { key: 56, id: 'dcStandby', type: 'u8', writable: true },
  { key: 57, id: 'usbStandby', type: 'u8', writable: true },
  { key: 58, id: 'acStandby', type: 'u8', writable: true },
];

const BY_KEY = new Map(REGISTERS.map((r) => [r.key, r]));
export const KEY: Record<string, number> = Object.fromEntries(REGISTERS.map((r) => [r.id, r.key]));

// ---------------------------------------------------------------- bytes / hex

export function hexToBytes(hex: string): Uint8Array {
  const clean = hex.replace(/[^0-9a-f]/gi, '');
  const out = new Uint8Array(clean.length >> 1);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.substr(i * 2, 2), 16);
  return out;
}

export function bytesToHex(bytes: Uint8Array, sep = ''): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join(sep).toUpperCase();
}

export function crc16modbus(bytes: ArrayLike<number>): number {
  let crc = 0xffff;
  for (let i = 0; i < bytes.length; i++) {
    crc ^= bytes[i] & 0xff;
    for (let b = 0; b < 8; b++) crc = crc & 1 ? (crc >>> 1) ^ 0xa001 : crc >>> 1;
  }
  return crc;
}

// ---------------------------------------------------------------- commands

/** Builds the 14-byte write frame the original app sends (`14,0,12,0,8,0,record,crcHi,crcLo`). */
export function buildWriteCommand(key: number, value: number): Uint8Array {
  const v = Math.max(0, Math.min(0xffff, Math.round(value)));
  const record = [key & 0xff, (key >> 8) & 0xff, v & 0xff, (v >> 8) & 0xff, 0, 0];
  const crc = crc16modbus(record);
  return Uint8Array.from([0x0e, 0x00, 0x0c, 0x00, 0x08, 0x00, ...record, crc >> 8, crc & 0xff]);
}

// ---------------------------------------------------------------- parsing

export interface Frame {
  type: number;
  /** Raw 4-byte value per register key. */
  records: Map<number, Uint8Array>;
  raw: Uint8Array;
}

export function parseFrame(raw: Uint8Array): Frame | null {
  if (raw.length < 8) return null;
  const type = raw[2] | (raw[3] << 8);
  const records = new Map<number, Uint8Array>();
  // Same loop bounds as the original parser: records stop 2 bytes before the end (CRC).
  for (let off = 6; off + 6 <= raw.length - 2; off += 6) {
    const key = raw[off] | (raw[off + 1] << 8);
    records.set(key, raw.slice(off + 2, off + 6));
  }
  return { type, records, raw };
}

export function decodeValue(def: RegisterDef, v: Uint8Array): number | string {
  const u32 = (v[0] | (v[1] << 8) | (v[2] << 16) | (v[3] << 24)) >>> 0;
  let n: number;
  switch (def.type) {
    case 'u8':
    case 'bool':
      n = v[0];
      break;
    case 'i8':
      n = (v[0] << 24) >> 24;
      break;
    case 'u16':
      n = v[0] | (v[1] << 8);
      break;
    case 'i16':
      n = ((v[0] | (v[1] << 8)) << 16) >> 16;
      break;
    case 'i32':
      // The app treats values with a 0x0000/0xFFFF upper half as sign-extended 16-bit.
      if ((v[2] === 0 && v[3] === 0) || (v[2] === 0xff && v[3] === 0xff)) {
        n = ((v[0] | (v[1] << 8)) << 16) >> 16;
      } else {
        n = u32 | 0;
      }
      break;
    case 'u32':
      n = u32;
      break;
    case 'ver32':
      return [v[3], v[2], v[1], v[0]].map((b) => b.toString(16).padStart(2, '0')).join('-');
    case 'hex16':
      return (v[0] | (v[1] << 8)).toString(16).padStart(4, '0');
  }
  return def.scale ? Math.round(n * def.scale * 1000) / 1000 : n;
}

/** Decodes every known register present in the frame, keyed by register id. */
export function decodeRegisters(frame: Frame): Record<string, number | string> {
  const out: Record<string, number | string> = {};
  for (const [key, bytes] of frame.records) {
    const def = BY_KEY.get(key);
    if (def) out[def.id] = decodeValue(def, bytes);
  }
  return out;
}

// ---------------------------------------------------------------- stream framing

function validHeaderAt(buf: Uint8Array, off: number): boolean {
  if (buf.length - off < 6) return false;
  const len = buf[off] | (buf[off + 1] << 8);
  const plen = buf[off + 4] | (buf[off + 5] << 8);
  return len >= 8 && plen === len - 6;
}

/**
 * Splits a TCP byte stream into frames using the LEN field.
 *
 * The original app never does this: it treats one socket read as one frame, and the sample frame
 * shipped in the app even has a LEN that is shorter than the real payload. So LEN is only trusted
 * when it is consistent with the stream; otherwise the whole buffered chunk is one frame.
 * Call flush() after a short idle period to release an incomplete tail.
 */
export class FrameAssembler {
  private buf = new Uint8Array(0);

  push(chunk: Uint8Array): Uint8Array[] {
    const merged = new Uint8Array(this.buf.length + chunk.length);
    merged.set(this.buf);
    merged.set(chunk, this.buf.length);
    this.buf = merged;

    const frames: Uint8Array[] = [];
    while (this.buf.length > 0) {
      if (!validHeaderAt(this.buf, 0)) {
        if (this.buf.length < 6) break; // wait for the rest of the header
        frames.push(this.take(this.buf.length));
        break;
      }
      const len = this.buf[0] | (this.buf[1] << 8);
      if (this.buf.length < len) break; // wait for the rest of the frame
      const rest = this.buf.length - len;
      if (rest === 0 || rest < 6 || validHeaderAt(this.buf, len)) {
        frames.push(this.take(len));
      } else {
        frames.push(this.take(this.buf.length)); // LEN disagrees with the stream
        break;
      }
    }
    return frames;
  }

  /** Returns whatever is buffered as a frame (or null) and clears the buffer. */
  flush(): Uint8Array | null {
    return this.buf.length ? this.take(this.buf.length) : null;
  }

  reset(): void {
    this.buf = new Uint8Array(0);
  }

  private take(n: number): Uint8Array {
    const out = this.buf.slice(0, n);
    this.buf = this.buf.slice(n);
    return out;
  }
}

// ---------------------------------------------------------------- setting options

export const LedMode = { Off: 0, On: 1, SOS: 2, Strobe: 3 } as const;
export type LedMode = (typeof LedMode)[keyof typeof LedMode];

export const SCREEN_TIMEOUT_OPTIONS = ['Ніколи', '1 хв', '5 хв', '10 хв', '30 хв'];
export const STANDBY_OPTIONS = ['Ніколи', '30 хв', '1 год', '4 год', '8 год', '12 год', '24 год'];
