import { api, onUnauthorized, triggerUnauthorized } from './api.ts';
import type { UiDeps } from './deps.ts';
import { fmtClock } from './format.ts';
import { LiveClient, liveUrl } from './live.ts';
import { createAuthPage } from './pages/auth.ts';
import { createHomePage } from './pages/home.ts';
import { createSettingsPage } from './pages/settings.ts';
import { Router } from './router.ts';
import { browserStorage, clearPersisted, createAppStore, type AppState, type Store } from './store.ts';
import { applyLive, checkSessionAfterReject, hubStatusFor, shouldRefreshOnEvent } from './sync.ts';
import { h, icon, ICONS, setText } from './ui/dom.ts';
import { confirmSheet } from './ui/sheet.ts';
import { toast } from './ui/toast.ts';

export const TABS = [
  { path: '/', label: 'Головна', icon: ICONS.home },
  { path: '/settings', label: 'Налаштування', icon: ICONS.sliders },
] as const;

export function mountShell(root: HTMLElement, store: Store<AppState>) {
  const dot = () => h('span', { class: 'dot' });
  const hubDot = dot();
  const stationDot = dot();
  const banner = h('div', { class: 'banner', attrs: { role: 'status' } });
  banner.hidden = true;
  const outlet = h('main', { class: 'content' });
  const tabs = TABS.map((t) => h('a', { class: 'tab', attrs: { href: `#${t.path}`, 'data-path': t.path } }, icon(t.icon), h('span', { text: t.label })));
  const shell = h(
    'div',
    { class: 'shell' },
    h(
      'header',
      { class: 'topbar safe-top' },
      h('div', { class: 'brand' }, 'Fossibot', h('span', { text: 'F1800' })),
      h(
        'div',
        { class: 'conn' },
        h('span', { class: 'conn-item', attrs: { 'data-conn': 'hub' } }, hubDot, 'Хаб'),
        h('span', { class: 'conn-item', attrs: { 'data-conn': 'station' } }, stationDot, 'Станція'),
      ),
    ),
    banner,
    outlet,
    h('nav', { class: 'tabbar safe-bottom', attrs: { 'aria-label': 'Розділи' } }, ...tabs),
  );
  root.replaceChildren(shell);

  const render = (st: AppState) => {
    hubDot.dataset.state = st.hub === 'online' ? 'ok' : st.hub === 'connecting' ? 'warn' : 'bad';
    const link = st.view?.link;
    stationDot.dataset.state = st.hub !== 'online' || !link ? 'none' : link === 'up' ? 'ok' : 'bad';
    banner.hidden = st.hub !== 'offline';
    setText(banner, st.lastDataAt ? `Немає зв'язку з хабом · останні дані о ${fmtClock(st.lastDataAt / 1000)}` : "Немає зв'язку з хабом");
  };
  render(store.get());
  const unsubscribe = store.subscribe(render);

  return {
    outlet,
    setActive(path: string) {
      for (const t of tabs) {
        if (t.dataset.path === path) t.setAttribute('aria-current', 'page');
        else t.removeAttribute('aria-current');
      }
    },
    destroy() {
      unsubscribe();
    },
  };
}

/** Mounts the logged-in app; returns a function that tears it down. */
export function startApp(root: HTMLElement): () => void {
  const store = createAppStore(browserStorage());
  const deps: UiDeps = {
    store,
    api,
    run: (register, value) => api.command(register, value),
    confirm: confirmSheet,
    notify: (message, tone = 'info') => void toast(message, tone),
    onLoggedOut: () => {
      clearPersisted();
      location.reload();
    },
  };
  const shell = mountShell(root, store);
  const router = new Router(shell.outlet, { '/': () => createHomePage(deps), '/settings': () => createSettingsPage(deps) }, (p) =>
    shell.setActive(p),
  );
  const refresh = () =>
    api.state().then(
      (view) => store.set({ view, lastDataAt: Date.now() }),
      () => {},
    );
  const live = new LiveClient({
    url: liveUrl(location),
    onMessage: (m) => {
      applyLive(store, m);
      if (shouldRefreshOnEvent(m)) void refresh();
    },
    onStatus: (s) => store.set({ hub: hubStatusFor(store.get().hub, s) }),
    onRejected: () => void checkSessionAfterReject(api.authStatus, triggerUnauthorized),
  });
  const onVisible = () => {
    if (document.visibilityState !== 'visible') return;
    live.kick();
    void refresh();
  };
  const refreshTimer = setInterval(refresh, 60_000);
  document.addEventListener('visibilitychange', onVisible);
  router.start();
  live.start();
  void refresh();
  return () => {
    clearInterval(refreshTimer);
    document.removeEventListener('visibilitychange', onVisible);
    live.stop();
    router.stop();
    shell.destroy();
  };
}

export async function boot(root: HTMLElement): Promise<void> {
  let stop: (() => void) | null = null;
  const showAuth = (setUp: boolean) => {
    stop?.();
    stop = null;
    const page = createAuthPage({ setUp, onDone: () => (stop = startApp(root)) });
    root.replaceChildren(page.el);
  };
  onUnauthorized(() => showAuth(true));
  try {
    const status = await api.authStatus();
    if (!status.loggedIn) return showAuth(status.setUp);
  } catch {
    // Hub unreachable: show the app anyway; the banner explains and the socket keeps retrying.
  }
  stop = startApp(root);
}
