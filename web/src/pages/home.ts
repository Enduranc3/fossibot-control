import { createBatteryRing } from '../components/battery-ring.ts';
import { createEnergyToday } from '../components/energy-today.ts';
import { createGridStatus } from '../components/grid-status.ts';
import { createPowerCards } from '../components/power-cards.ts';
import type { UiDeps } from '../deps.ts';
import { flowOf } from '../format.ts';
import type { Page } from '../router.ts';
import type { AppState } from '../store.ts';
import { h } from '../ui/dom.ts';

export function createHomePage(deps: UiDeps): Page {
  const ring = createBatteryRing();
  const status = createGridStatus();
  const today = createEnergyToday();
  const power = createPowerCards();
  const el = h('div', { class: 'home' }, h('section', { class: 'hero' }, ring.el, status.el), today.el, power.el);
  const nowSec = () => Math.floor(Date.now() / 1000);

  const render = (st: AppState) => {
    const view = st.view;
    const snap = view?.snapshot ?? null;
    ring.update(snap ? snap.soc : null, snap ? flowOf(snap) : 'idle');
    status.update(view, nowSec());
    today.update(view?.today ?? null);
    power.update(snap);
  };
  render(deps.store.get());
  const unsubscribe = deps.store.subscribe(render);
  // Keeps "Мережа є · 3 год 12 хв" ticking between data updates.
  const tick = setInterval(() => status.update(deps.store.get().view, nowSec()), 30_000);

  return {
    el,
    destroy() {
      unsubscribe();
      clearInterval(tick);
    },
  };
}
