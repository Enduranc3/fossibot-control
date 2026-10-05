import type { AppState, HubConnection, Store } from './store.ts';
import type { LiveMessage } from './types.ts';

export function applyLive(store: Store<AppState>, m: LiveMessage, now = Date.now()): void {
  const view = store.get().view;
  switch (m.type) {
    case 'hello':
      store.set({ view: m.state, lastDataAt: now, hub: 'online' });
      return;
    case 'telemetry':
      if (view) store.set({ view: { ...view, snapshot: m.snapshot, link: 'up' }, lastDataAt: now });
      return;
    case 'link':
      if (view) store.set({ view: { ...view, link: m.state }, lastDataAt: now });
      return;
    case 'grid':
      if (view) store.set({ view: { ...view, grid: { present: m.present, sinceSec: m.sinceSec } }, lastDataAt: now });
      return;
    case 'event':
      store.set({ lastDataAt: now });
      return;
  }
}

export function hubStatusFor(prev: HubConnection, s: 'connecting' | 'open' | 'closed'): HubConnection {
  if (s === 'open') return 'online';
  if (s === 'closed') return 'offline';
  return prev === 'connecting' ? 'connecting' : prev === 'online' ? 'online' : 'offline';
}

export function shouldRefreshOnEvent(m: LiveMessage): boolean {
  return m.type === 'event' && (m.event.type === 'grid_lost' || m.event.type === 'grid_restored');
}

/** A socket that closes before opening may mean the session is gone; ask the hub before logging out. */
export async function checkSessionAfterReject(
  authStatus: () => Promise<{ loggedIn: boolean }>,
  onLoggedOut: () => void,
): Promise<void> {
  try {
    if (!(await authStatus()).loggedIn) onLoggedOut();
  } catch {
    // hub unreachable: keep retrying the socket, the banner already says so
  }
}
