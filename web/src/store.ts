import type { StateView } from './types.ts';

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
}

export function createAppStore(): Store<AppState> {
  return new Store<AppState>({ view: null, hub: 'connecting', lastDataAt: null, pending: {} });
}
