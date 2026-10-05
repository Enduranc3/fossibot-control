import type { Prefs, Session, StateView } from './types.ts';

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const MESSAGES: Record<string, string> = {
  network: "Немає зв'язку з хабом",
  unauthorized: 'Потрібно увійти знову',
  wrong_password: 'Невірний пароль',
  not_confirmed: 'Станція не підтвердила команду',
  station_offline: "Станція не на зв'язку",
  invalid: 'Недопустиме значення',
  password_too_short: 'Пароль — щонайменше 8 символів',
  already_set_up: 'Пароль уже задано',
};

/** These answer 401 as part of their normal flow; they must not bounce the user to the login screen. */
const AUTH_PATHS = ['/api/login', '/api/setup', '/api/auth/status'];

let unauthorizedHandler: () => void = () => {};
export function onUnauthorized(fn: () => void): void {
  unauthorizedHandler = fn;
}
export function triggerUnauthorized(): void {
  unauthorizedHandler();
}

export async function request<T>(method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      credentials: 'same-origin',
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, 'network', MESSAGES.network);
  }
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (res.ok) return data as T;
  const code = typeof data.error === 'string' ? data.error : `http_${res.status}`;
  if (res.status === 401 && !AUTH_PATHS.includes(path)) unauthorizedHandler();
  let message = typeof data.message === 'string' ? data.message : (MESSAGES[code] ?? `Помилка ${res.status}`);
  if (code === 'too_many_attempts') {
    const minutes = Math.max(1, Math.ceil(Number(data.retryAfterSec ?? 60) / 60));
    message = `Забагато спроб. Спробуйте через ${minutes} хв`;
  }
  throw new ApiError(res.status, code, message);
}

export const api = {
  authStatus: () => request<{ setUp: boolean; loggedIn: boolean }>('GET', '/api/auth/status'),
  setup: (password: string) => request<{ ok: true }>('POST', '/api/setup', { password }),
  login: (password: string) => request<{ ok: true }>('POST', '/api/login', { password }),
  logout: () => request<{ ok: true }>('POST', '/api/logout', {}),
  state: () => request<StateView>('GET', '/api/state'),
  command: (register: string, value: number) => request<{ ok: true }>('POST', '/api/command', { register, value }),
  prefs: () => request<Prefs>('GET', '/api/prefs'),
  updatePrefs: (patch: Partial<Prefs>) => request<Prefs>('PUT', '/api/prefs', patch),
  sessions: () => request<(Session & { current: boolean })[]>('GET', '/api/sessions'),
  revokeSession: (id: string) => request<{ ok: true }>('DELETE', `/api/sessions/${encodeURIComponent(id)}`),
};

export type Api = typeof api;
