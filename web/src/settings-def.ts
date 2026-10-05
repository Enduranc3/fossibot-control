type Options = readonly (readonly [number, string])[];

export type SettingDef =
  | { register: string; label: string; kind: 'slider'; min: number; max: number; step: number; unit: string; hint?: string }
  | { register: string; label: string; kind: 'select'; options: Options; hint?: string }
  | { register: string; label: string; kind: 'segmented'; options: Options; hint?: string }
  | { register: string; label: string; kind: 'switch'; invert?: boolean; hint?: string };

export const STANDBY_OPTIONS: Options = [
  [0, 'Ніколи'],
  [1, 'Через 30 хв'],
  [2, 'Через 1 год'],
  [3, 'Через 4 год'],
  [4, 'Через 8 год'],
  [5, 'Через 12 год'],
  [6, 'Через 24 год'],
];

export const STATION_SETTINGS: readonly SettingDef[] = [
  { register: 'ecoMode', label: 'Режим роботи', kind: 'segmented', options: [[0, 'UPS'], [1, 'ECO']], hint: 'UPS — миттєве перемикання при відключенні; ECO — менше власне споживання' },
  { register: 'chargePowerW', label: 'Потужність заряджання від мережі', kind: 'slider', min: 100, max: 1200, step: 100, unit: 'W' },
  { register: 'chargeLimit', label: 'Заряджати до', kind: 'slider', min: 60, max: 100, step: 1, unit: '%' },
  { register: 'dischargeLimit', label: 'Розряджати до', kind: 'slider', min: 0, max: 20, step: 1, unit: '%' },
  { register: 'dcChargeCurrent', label: 'Струм DC-заряджання', kind: 'slider', min: 1, max: 15, step: 1, unit: 'A', hint: 'Понад 8 A — лише для джерел, що їх витримують' },
  { register: 'screenBrightness', label: 'Яскравість екрана', kind: 'slider', min: 0, max: 100, step: 5, unit: '%' },
  { register: 'screenTimeout', label: 'Вимкнення екрана', kind: 'select', options: [[0, 'Ніколи'], [1, '1 хв'], [2, '5 хв'], [3, '10 хв'], [4, '30 хв']] },
  { register: 'acStandby', label: 'Автовимкнення AC', hint: 'Якщо до виходу нічого не підключено', kind: 'select', options: STANDBY_OPTIONS },
  { register: 'dcStandby', label: 'Автовимкнення DC', kind: 'select', options: STANDBY_OPTIONS },
  { register: 'usbStandby', label: 'Автовимкнення USB', kind: 'select', options: STANDBY_OPTIONS },
  { register: 'keySoundOff', label: 'Звук кнопок', kind: 'switch', invert: true },
  { register: 'acRestoreOnPower', label: 'Вмикати AC після відновлення живлення', kind: 'switch' },
];
