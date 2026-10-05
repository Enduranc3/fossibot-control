import { DASH, fmtKwh } from '../format.ts';
import type { EnergyTotals } from '../types.ts';
import { h, setText } from '../ui/dom.ts';

export function createEnergyToday() {
  const stat = (label: string) => {
    const v = h('div', { class: 'stat-v num', text: DASH });
    return { v, el: h('div', { class: 'stat' }, v, h('div', { class: 'stat-l', text: label })) };
  };
  const grid = stat('З мережі');
  const out = stat('Спожито');
  const solar = stat('Сонце');
  const el = h('section', { class: 'today' }, h('div', { class: 'today-title', text: 'Сьогодні, кВт·год' }), h('div', { class: 'today-grid card' }, grid.el, out.el, solar.el));
  return {
    el,
    update(today: EnergyTotals | null) {
      setText(grid.v, today ? fmtKwh(today.gridInWh) : DASH);
      setText(out.v, today ? fmtKwh(today.outWh) : DASH);
      setText(solar.v, today ? fmtKwh(today.solarInWh) : DASH);
    },
  };
}
