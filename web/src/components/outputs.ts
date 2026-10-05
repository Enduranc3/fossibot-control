import type { UiDeps } from '../deps.ts';
import { canControl, currentValue, setLed, toggleOutput, type OutputRegister } from '../outputs.ts';
import type { AppState } from '../store.ts';
import { h, setText } from '../ui/dom.ts';

const TILES: { register: OutputRegister | 'led'; name: string; sub: string }[] = [
  { register: 'acOn', name: 'AC 220V', sub: 'Розетки' },
  { register: 'dcOn', name: 'DC 12V', sub: 'Автомобільний вихід' },
  { register: 'usbOn', name: 'USB', sub: 'USB-A · USB-C' },
  { register: 'led', name: 'Ліхтар', sub: 'Підсвітка станції' },
];

const LED_MODES: [number, string][] = [
  [1, 'Постійно'],
  [2, 'SOS'],
  [3, 'Стробоскоп'],
];
const LED_NAME: Record<number, string> = { 0: 'Вимкнено', 1: 'Постійно', 2: 'SOS', 3: 'Стробоскоп' };

export function createOutputs(deps: UiDeps) {
  const tiles = TILES.map((t) => {
    const state = h('div', { class: 'tile-state', text: '—' });
    const el = h(
      'button',
      { class: 'tile card', attrs: { type: 'button', 'data-output': t.register } },
      h('div', { class: 'tile-top' }, h('span', { class: 'tile-name', text: t.name }), h('span', { class: 'tile-dot' })),
      h('div', {}, state, h('div', { class: 'tile-sub', text: t.sub })),
    );
    el.addEventListener('click', () => {
      if (t.register === 'led') {
        const led = currentValue(deps.store.get(), 'led');
        if (led !== null) void setLed(deps, led ? 0 : 1);
      } else {
        void toggleOutput(deps, t.register);
      }
    });
    return { t, el, state };
  });
  const modeButtons = LED_MODES.map(([mode, label]) => {
    const b = h('button', { text: label, attrs: { type: 'button', 'aria-pressed': 'false' } });
    b.addEventListener('click', () => void setLed(deps, mode));
    return { mode, b };
  });
  const ledModes = h('div', { class: 'segmented led-modes', attrs: { role: 'group', 'aria-label': 'Режим ліхтаря' } }, ...modeButtons.map((m) => m.b));
  ledModes.hidden = true;

  return {
    el: h('section', {}, h('div', { class: 'outputs' }, ...tiles.map((x) => x.el)), ledModes),
    update(st: AppState) {
      const enabled = canControl(st);
      for (const { t, el, state } of tiles) {
        const v = currentValue(st, t.register);
        const pending = t.register in st.pending;
        el.disabled = !enabled || v === null;
        el.dataset.on = String(!!v);
        el.dataset.pending = String(pending);
        const text = pending ? 'Зачекайте…' : v === null ? '—' : t.register === 'led' ? (LED_NAME[v] ?? `Режим ${v}`) : v ? 'Увімкнено' : 'Вимкнено';
        setText(state, text);
      }
      const led = currentValue(st, 'led');
      ledModes.hidden = !led;
      for (const { mode, b } of modeButtons) {
        b.setAttribute('aria-pressed', String(led === mode));
        b.disabled = !enabled;
      }
    },
  };
}
