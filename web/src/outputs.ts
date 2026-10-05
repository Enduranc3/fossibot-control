import type { UiDeps } from './deps.ts';
import type { AppState } from './store.ts';
import type { ConfirmOptions } from './ui/sheet.ts';

export type OutputRegister = 'acOn' | 'dcOn' | 'usbOn';

export const AC_OFF_CONFIRM: ConfirmOptions = {
  title: 'Вимкнути AC?',
  body: 'Пристрої, підключені до розеток станції, знеструмляться.',
  confirmText: 'Вимкнути',
  tone: 'danger',
};

export function canControl(st: AppState): boolean {
  return st.hub === 'online' && st.view?.link === 'up' && !!st.view.snapshot;
}

export function currentValue(st: AppState, register: string): number | null {
  const v = st.view?.snapshot?.registers[register];
  return typeof v === 'number' ? v : null;
}

/** Sends one command; at most one per register at a time. Resolves true when the station confirmed it. */
export async function sendCommand(deps: Pick<UiDeps, 'store' | 'run' | 'notify'>, register: string, value: number): Promise<boolean> {
  const { store } = deps;
  if (!canControl(store.get()) || register in store.get().pending) return false;
  store.set({ pending: { ...store.get().pending, [register]: value } });
  try {
    await deps.run(register, value);
    return true;
  } catch (err) {
    deps.notify(err instanceof Error ? err.message : String(err), 'error');
    return false;
  } finally {
    const rest = { ...store.get().pending };
    delete rest[register];
    store.set({ pending: rest });
  }
}

export async function toggleOutput(deps: Pick<UiDeps, 'store' | 'run' | 'notify' | 'confirm'>, register: OutputRegister): Promise<boolean> {
  const current = currentValue(deps.store.get(), register);
  if (current === null || register in deps.store.get().pending) return false;
  const target = current ? 0 : 1;
  if (register === 'acOn' && target === 0 && !(await deps.confirm(AC_OFF_CONFIRM))) return false;
  return sendCommand(deps, register, target);
}

export function setLed(deps: Pick<UiDeps, 'store' | 'run' | 'notify'>, mode: number): Promise<boolean> {
  return sendCommand(deps, 'led', mode);
}
