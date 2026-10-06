import type { HubEvent, StateView } from './types.ts';

export type Listener<T> = (state: T, prev: T) => void;

export class Store<T extends object> {
  private state: T;
  private readonly listeners = new Set<Listener<T>>();

  constructor(initial: T) {
    this.state = initial;
  }

  get(): T {
    return this.state;
  }

  set(patch: Partial<T>): void {
    const prev = this.state;
    this.state = { ...prev, ...patch };
    for (const fn of [...this.listeners]) fn(this.state, prev);
  }

  subscribe(fn: Listener<T>): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }
}

export type HubConnection = 'connecting' | 'online' | 'offline';

export interface AppState {
  view: StateView | null;
  hub: HubConnection;
  /** ms timestamp of the last message from the hub */
  lastDataAt: number | null;
  /** register id → value being written; the UI shows these as pending */
  pending: Record<string, number>;
  /** last event pushed by the hub; pages that list events watch it (never persisted) */
  lastEvent: HubEvent | null;
}

export type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

const PERSIST_KEY = 'fossibot.lastState';
const PERSIST_EVERY_MS = 5000;

/** The browser's localStorage, or null where it is unavailable (private mode, tests). */
export function browserStorage(): StorageLike | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

function load(storage: StorageLike): Pick<AppState, 'view' | 'lastDataAt'> | null {
  try {
    const raw = storage.getItem(PERSIST_KEY);
    const v = raw ? (JSON.parse(raw) as Partial<AppState>) : null;
    return v && typeof v === 'object' && v.view ? { view: v.view, lastDataAt: v.lastDataAt ?? null } : null;
  } catch {
    return null;
  }
}

/**
 * With storage, the last view is restored on start (iOS often kills the app; reopening it without
 * signal should still show the last data and its time) and saved at most every 5 s.
 */
export function createAppStore(storage: StorageLike | null = null): Store<AppState> {
  const saved = storage ? load(storage) : null;
  const store = new Store<AppState>({ view: saved?.view ?? null, hub: 'connecting', lastDataAt: saved?.lastDataAt ?? null, pending: {}, lastEvent: null });
  if (storage) {
    let lastWrite = -Infinity;
    store.subscribe((st, prev) => {
      if (st.view === prev.view && st.lastDataAt === prev.lastDataAt) return;
      const now = Date.now();
      if (now - lastWrite < PERSIST_EVERY_MS) return;
      lastWrite = now;
      try {
        storage.setItem(PERSIST_KEY, JSON.stringify({ view: st.view, lastDataAt: st.lastDataAt }));
      } catch {
        // storage full or blocked: persistence is a convenience
      }
    });
  }
  return store;
}

export function clearPersisted(storage: StorageLike | null = browserStorage()): void {
  try {
    storage?.removeItem(PERSIST_KEY);
  } catch {
    // ignore
  }
}
