/** A register the app may write, with the range the official app allows. */
export interface CommandSpec {
  key: number;
  min: number;
  max: number;
  step?: number;
}

export const WRITABLE: Readonly<Record<string, CommandSpec>> = {
  led: { key: 38, min: 0, max: 3 },
  acOn: { key: 39, min: 0, max: 1 },
  dcOn: { key: 40, min: 0, max: 1 },
  usbOn: { key: 41, min: 0, max: 1 },
  chargePowerW: { key: 42, min: 100, max: 1200, step: 100 },
  acRestoreOnPower: { key: 43, min: 0, max: 1 },
  screenTimeout: { key: 44, min: 0, max: 4 },
  acStandbyLegacy: { key: 45, min: 0, max: 6 },
  ecoMode: { key: 46, min: 0, max: 1 },
  chargeLimit: { key: 49, min: 60, max: 100 },
  dischargeLimit: { key: 50, min: 0, max: 20 },
  keySoundOff: { key: 51, min: 0, max: 1 },
  screenBrightness: { key: 52, min: 0, max: 100 },
  dcChargeCurrent: { key: 53, min: 1, max: 15 },
  dcStandby: { key: 56, min: 0, max: 6 },
  usbStandby: { key: 57, min: 0, max: 6 },
  acStandby: { key: 58, min: 0, max: 6 },
};

/** Returns a user-facing error, or null when the command is allowed. */
export function validateCommand(register: string, value: unknown): string | null {
  const spec = Object.hasOwn(WRITABLE, register) ? WRITABLE[register] : undefined;
  if (!spec) return `Невідомий або недоступний для запису регістр: ${register}`;
  if (typeof value !== 'number' || !Number.isInteger(value)) return 'Значення має бути цілим числом';
  if (value < spec.min || value > spec.max) return `Допустимі значення: ${spec.min}–${spec.max}`;
  if (spec.step && (value - spec.min) % spec.step !== 0) return `Значення має бути кратним ${spec.step}`;
  return null;
}
