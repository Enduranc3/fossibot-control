import type { Api } from './api.ts';
import type { AppState, Store } from './store.ts';
import type { ConfirmOptions } from './ui/sheet.ts';
import type { ToastTone } from './ui/toast.ts';

/** Everything a page needs, injected so pages can be tested without a hub. */
export interface UiDeps {
  store: Store<AppState>;
  api: Api;
  run(register: string, value: number): Promise<unknown>;
  confirm(o: ConfirmOptions): Promise<boolean>;
  notify(message: string, tone?: ToastTone): void;
  onLoggedOut(): void;
}
