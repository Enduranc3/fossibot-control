import { FLOW_LABEL, socTone, type Flow } from '../format.ts';
import { h, s, setText } from '../ui/dom.ts';
import { tweenNumber } from '../ui/tween.ts';

const R = 100;
const C = 2 * Math.PI * R;

export function createBatteryRing() {
  const value = s('circle', { cx: 120, cy: 120, r: R, class: 'ring-value', 'stroke-dasharray': C.toFixed(2) });
  value.style.strokeDashoffset = String(C);
  const svg = s('svg', { viewBox: '0 0 240 240', class: 'ring-svg', 'aria-hidden': 'true' }, s('circle', { cx: 120, cy: 120, r: R, class: 'ring-track' }), value);
  const pct = h('span', { class: 'ring-pct num', text: '—' });
  const label = h('div', { class: 'ring-label', text: 'Немає даних' });
  const el = h('div', { class: 'ring', attrs: { role: 'img', 'aria-label': 'Заряд батареї' } }, svg, h('div', { class: 'ring-center' }, h('div', { class: 'ring-num' }, pct, h('span', { class: 'ring-unit', text: '%' })), label));
  el.dataset.tone = 'none';
  let shown: number | null = null;

  return {
    el,
    update(soc: number | null, flow: Flow) {
      if (soc === null || !Number.isFinite(soc)) {
        shown = null;
        setText(pct, '—');
        setText(label, 'Немає даних');
        value.style.strokeDashoffset = String(C);
        el.dataset.tone = 'none';
        el.dataset.flow = 'idle';
        return;
      }
      const v = Math.max(0, Math.min(100, soc));
      value.style.strokeDashoffset = String(C * (1 - v / 100));
      el.dataset.tone = socTone(v);
      el.dataset.flow = flow;
      el.setAttribute('aria-label', `Заряд батареї ${Math.round(v)}%`);
      if (shown !== v) tweenNumber(pct, shown ?? v, v, (x) => String(Math.round(x)));
      shown = v;
      setText(label, FLOW_LABEL[flow]);
    },
  };
}
