import { DASH, fmtW } from '../format.ts';
import type { Snapshot } from '../types.ts';
import { h, setText } from '../ui/dom.ts';
import { tweenNumber } from '../ui/tween.ts';

function row(label: string) {
  const v = h('b', { class: 'num', text: DASH });
  return { v, el: h('div', {}, h('span', { text: label }), h('span', {}, v, ' W')) };
}

function card(cls: string, title: string, rows: ReturnType<typeof row>[]) {
  const val = h('span', { class: 'num', text: DASH });
  const el = h('div', { class: `power-card card ${cls}` }, h('div', { class: 'power-head', text: title }), h('div', { class: 'power-val' }, val, h('small', { text: 'W' })), h('div', { class: 'power-rows' }, ...rows.map((r) => r.el)));
  return { el, val };
}

export function createPowerCards() {
  const grid = row('Мережа');
  const solar = row('Сонце');
  const ac = row('AC');
  const dc = row('DC');
  const usb = row('USB');
  const input = card('power-in', 'Вхід', [grid, solar]);
  const output = card('power-out', 'Навантаження', [ac, dc, usb]);
  let shownIn: number | null = null;
  let shownOut: number | null = null;
  const big = (el: HTMLElement, from: number | null, to: number) => tweenNumber(el, from ?? to, to, (x) => fmtW(x), 300);

  return {
    el: h('section', { class: 'power' }, input.el, output.el),
    update(snap: Snapshot | null) {
      if (!snap) {
        shownIn = shownOut = null;
        for (const e of [input.val, output.val, grid.v, solar.v, ac.v, dc.v, usb.v]) setText(e, DASH);
        return;
      }
      if (shownIn !== snap.inW) big(input.val, shownIn, snap.inW);
      if (shownOut !== snap.outW) big(output.val, shownOut, snap.outW);
      shownIn = snap.inW;
      shownOut = snap.outW;
      setText(grid.v, fmtW(snap.acInW));
      setText(solar.v, fmtW(snap.solarW));
      setText(ac.v, fmtW(snap.acOutW));
      setText(dc.v, fmtW(snap.dcW));
      setText(usb.v, fmtW(snap.usbW));
    },
  };
}
