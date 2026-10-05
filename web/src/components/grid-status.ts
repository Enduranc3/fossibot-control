import { forecastLine, gridLine } from '../format.ts';
import type { StateView } from '../types.ts';
import { h, setText } from '../ui/dom.ts';

export function createGridStatus() {
  const dot = h('span', { class: 'dot' });
  const text = h('span', { text: 'Очікуємо дані' });
  const sub = h('div', { class: 'status-sub' });
  const el = h('div', { class: 'status' }, h('div', { class: 'status-line' }, dot, text), sub);
  return {
    el,
    update(view: StateView | null, nowSec: number) {
      if (!view) {
        dot.dataset.state = 'none';
        setText(text, 'Очікуємо дані');
        setText(sub, '');
        return;
      }
      const g = gridLine(view, nowSec);
      dot.dataset.state = g.tone;
      setText(text, g.text);
      setText(sub, forecastLine(view));
    },
  };
}
