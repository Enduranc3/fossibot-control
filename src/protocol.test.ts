import { describe, expect, it } from 'vitest';
import {
  ACK_FRAME,
  FrameAssembler,
  KEY,
  buildWriteCommand,
  bytesToHex,
  crc16modbus,
  decodeRegisters,
  hexToBytes,
  parseFrame,
} from './protocol';

// Test frame embedded in the original app ("开发模式" sample in utils/power-hook.js).
const APP_SAMPLE =
  'd4000b00ce00010039000000020017002c0003005c0d00000400010000000500000000001200000000001300000000001400200000001500000000001600000000001700100000002200100000002300200000002400000000002500000000002600000000002700000000002800000000002900010000002a00840300002b00000100002c00020000002d00000000002e00010200002f000501011030002c00000031005002000032000b5000003300004c000034004c0000003500020100003600010000003700000000003800010500003900050200003A0002000000649c';

// Real report captured from an F1800 (fw 10-01-02-07) over TCP :8058 on 2026-10-05.
const REAL_F1800 =
  'e0000b00da0001003c00000002001e0000000300100e000004000000000005002801261012001610000013005500000014005500000015001a0900001600f40100001700000000002200550000002300550000002400000000002500000000002600000000002700010000002800000000002900000000002a00b00400002b00010000002c00010000002d00020000002e00000000002f000702011030000000000031003c00000032000000000033000000000034000f00000035000f0000003600010000003700000000003800030000003900030000003a000400000064ef';

describe('real station frame', () => {
  it('has a consistent header and a CRC over the records, high byte first', () => {
    const raw = hexToBytes(REAL_F1800);
    expect(raw.length).toBe(224);
    expect(raw[0] | (raw[1] << 8)).toBe(224);
    const crc = crc16modbus(raw.subarray(6, 222));
    expect([raw[222], raw[223]]).toEqual([crc >> 8, crc & 0xff]);
    expect(new FrameAssembler().push(raw)).toHaveLength(1);
  });

  it('decodes to the values shown by the station', () => {
    const regs = decodeRegisters(parseFrame(hexToBytes(REAL_F1800))!);
    expect(regs.soc).toBe(60);
    expect(regs.acOn).toBe(1);
    expect(regs.acOutputVoltage).toBe(233);
    expect(regs.acOutputFrequency).toBe(50);
    expect(regs.chargePowerW).toBe(1200);
    expect(regs.chargeLimit).toBe(60);
  });
});

describe('crc16modbus', () => {
  it('matches the standard CRC-16/MODBUS check value', () => {
    expect(crc16modbus(new TextEncoder().encode('123456789'))).toBe(0x4b37);
  });
});

describe('buildWriteCommand', () => {
  it.each([
    [KEY.acOn, 1, '0E000C0008002700010000003007'],
    [KEY.acOn, 0, '0E000C000800270000000000CC06'],
    [KEY.dcOn, 1, '0E000C000800280001000000CF07'],
    [KEY.led, 2, '0E000C000800260002000000A506'],
    [KEY.chargePowerW, 500, '0E000C0008002A00F40100002164'],
  ])('key %i = %i', (key, value, hex) => {
    expect(bytesToHex(buildWriteCommand(key, value))).toBe(hex);
  });

  it('reproduces the original app algorithm (CRC of the record only, high byte first)', () => {
    // Direct port of changeFn() from power-hook.js.
    const appBuild = (e: number, t: number) => {
      const r = [e, 0, t % 256, Math.floor(t / 256), 0, 0];
      let c = 65535;
      for (const b of r) {
        c ^= b & 255;
        for (let i = 0; i < 8; i++) c = c & 1 ? (c >> 1) ^ 40961 : c >> 1;
      }
      c = (((c & 255) << 8) | ((c >> 8) & 255)) & 65535;
      return [14, 0, 12, 0, 8, 0, ...r, c & 255, (c >> 8) & 255];
    };
    for (const [k, v] of [[39, 1], [42, 1200], [49, 60], [53, 8], [58, 6]]) {
      expect(Array.from(buildWriteCommand(k, v))).toEqual(appBuild(k, v));
    }
  });
});

describe('parseFrame / decodeRegisters', () => {
  it('decodes the app sample frame the same way the app does', () => {
    const regs = decodeRegisters(parseFrame(hexToBytes(APP_SAMPLE))!);
    expect(regs.soc).toBe(0x39); // 57 %
    expect(regs.batteryTempMax).toBe(0x17);
    expect(regs.remainingMinutes).toBe(0x0d5c);
    expect(regs.acOutputW).toBe(0x20);
    expect(regs.totalInputW).toBe(0x10);
    expect(regs.totalOutputW).toBe(0x20);
    expect(regs.usbOn).toBe(1);
    expect(regs.chargePowerW).toBe(900);
    expect(regs.ecoMode).toBe(1);
    expect(regs.firmwareVersion).toBe('10-01-01-05');
    expect(regs.chargeLimit).toBe(80);
  });

  it('decodes signed 16-bit values inside int32 registers', () => {
    const f = parseFrame(Uint8Array.from([14, 0, 11, 0, 8, 0, 9, 0, 0x18, 0xfc, 0xff, 0xff, 0, 0]))!;
    expect(decodeRegisters(f).batteryCurrent).toBe(-1);
  });
});

describe('FrameAssembler', () => {
  const cmd = buildWriteCommand(39, 1);

  it('splits concatenated frames and joins split ones', () => {
    const a = new FrameAssembler();
    const two = new Uint8Array([...cmd, ...cmd.slice(0, 5)]);
    expect(a.push(two)).toHaveLength(1);
    const rest = a.push(cmd.slice(5));
    expect(rest).toHaveLength(1);
    expect(bytesToHex(rest[0])).toBe(bytesToHex(cmd));
  });

  it('falls back to one chunk = one frame when LEN is inconsistent', () => {
    const a = new FrameAssembler();
    const frames = a.push(hexToBytes(APP_SAMPLE));
    expect(frames).toHaveLength(1);
    expect(frames[0].length).toBe(224);
  });

  it('accepts the ACK frame as a well-formed frame', () => {
    expect(new FrameAssembler().push(ACK_FRAME)).toHaveLength(1);
  });
});
