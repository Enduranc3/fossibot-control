import type { UiDeps } from '../deps.ts';
import { canControl, currentValue, sendCommand } from '../outputs.ts';
import type { SettingDef } from '../settings-def.ts';
import type { AppState } from '../store.ts';
import { h, setText } from '../ui/dom.ts';

export function createSettingRow(def: SettingDef, deps: UiDeps) {
  const valueEl = h('span', { class: 'row-value num' });
  const head = h('div', { class: 'row-head' }, h('span', { text: def.label }), valueEl);
  const el = h('div', { class: 'row', attrs: { 'data-register': def.register } }, head);
  let control: HTMLInputElement | HTMLSelectElement | HTMLButtonElement | null = null;
  let segButtons: { value: number; b: HTMLButtonElement }[] = [];
  let dragging = false;

  const send = async (value: number) => {
    const ok = await sendCommand(deps, def.register, value);
    if (!ok) update(deps.store.get(), true); // snap back to what the station reports
  };

  if (def.kind === 'slider') {
    const input = h('input', { class: 'slider', attrs: { type: 'range', min: String(def.min), max: String(def.max), step: String(def.step), 'aria-label': def.label } });
    const paint = () => {
      const v = Number(input.value);
      input.style.setProperty('--fill', `${((v - def.min) / (def.max - def.min)) * 100}%`);
      setText(valueEl, `${v} ${def.unit}`);
    };
    input.addEventListener('input', () => {
      dragging = true;
      paint();
    });
    input.addEventListener('change', () => {
      dragging = false;
      paint();
      void send(Number(input.value));
    });
    el.append(input);
    control = input;
  } else if (def.kind === 'select') {
    const select = h('select', { class: 'select', attrs: { 'aria-label': def.label } }, ...def.options.map(([v, label]) => h('option', { text: label, attrs: { value: String(v) } })));
    select.addEventListener('change', () => void send(Number(select.value)));
    valueEl.replaceWith(select);
    control = select;
  } else if (def.kind === 'switch') {
    const sw = h('button', { class: 'switch', attrs: { type: 'button', role: 'switch', 'aria-checked': 'false', 'aria-label': def.label } });
    sw.addEventListener('click', () => {
      const checked = sw.getAttribute('aria-checked') === 'true';
      const wantOn = !checked;
      void send(def.invert ? (wantOn ? 0 : 1) : wantOn ? 1 : 0);
    });
    valueEl.replaceWith(sw);
    control = sw;
  } else {
    segButtons = def.options.map(([value, label]) => {
      const b = h('button', { text: label, attrs: { type: 'button', 'aria-pressed': 'false' } });
      b.addEventListener('click', () => void send(value));
      return { value, b };
    });
    valueEl.remove();
    el.append(h('div', { class: 'segmented', attrs: { role: 'group', 'aria-label': def.label } }, ...segButtons.map((x) => x.b)));
  }
  if (def.hint) el.append(h('div', { class: 'row-hint', text: def.hint }));

  function update(st: AppState, force = false) {
    const v = currentValue(st, def.register);
    const pending = def.register in st.pending;
    const enabled = canControl(st) && v !== null;
    el.dataset.pending = String(pending);
    if (control) control.disabled = !enabled;
    for (const { b } of segButtons) b.disabled = !enabled;
    if (v === null) {
      if (def.kind === 'slider') setText(valueEl, '—');
      return;
    }
    if (def.kind === 'slider' && control instanceof HTMLInputElement) {
      if (dragging && !force) return;
      if (!pending || force) {
        control.value = String(v);
        control.style.setProperty('--fill', `${((v - def.min) / (def.max - def.min)) * 100}%`);
        setText(valueEl, `${v} ${def.unit}`);
      }
    } else if (def.kind === 'select' && control instanceof HTMLSelectElement) {
      if (document.activeElement !== control || force) control.value = String(v);
    } else if (def.kind === 'switch' && control) {
      const on = def.invert ? v === 0 : v === 1;
      control.setAttribute('aria-checked', String(on));
    } else {
      for (const { value, b } of segButtons) b.setAttribute('aria-pressed', String(v === value));
    }
  }

  return { el, update };
}
