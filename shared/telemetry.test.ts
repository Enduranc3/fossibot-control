import { describe, expect, it } from 'vitest';
import { REAL_F1800 } from './fixtures.ts';
import { decodeRegisters, hexToBytes, parseFrame } from './protocol.ts';
import { toSnapshot } from './telemetry.ts';

describe('toSnapshot', () => {
  it('maps the real F1800 report', () => {
    const s = toSnapshot(decodeRegisters(parseFrame(hexToBytes(REAL_F1800))!), 1_700_000_000_000);
    expect(s).toMatchObject({
      ts: 1_700_000_000_000,
      soc: 60,
      inW: 85,
      outW: 85,
      acInW: 85,
      acOutW: 85,
      solarW: 0,
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
    });
    expect(s.registers.chargePowerW).toBe(1200);
  });

  it('uses null/0 for registers the station did not send', () => {
    const s = toSnapshot({ soc: 10 }, 0);
    expect(s.acV).toBeNull();
    expect(s.inW).toBe(0);
    expect(s.chargeLimit).toBeNull();
  });
});
