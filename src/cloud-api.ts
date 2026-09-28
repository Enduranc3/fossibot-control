import { CapacitorHttp } from '@capacitor/core';
import { FossibotNet, isNative } from './native';

// Endpoints recovered from utils/http.js and utils/socket.js of the official app.
export const CLOUD_BASE = 'http://app.fossibot.hk/prod-api/';
export const CLOUD_WS = 'ws://app.fossibot.hk/ws';

export interface CloudDevice {
  id: number | string;
  snCode: string;
  deviceName: string;
  online: boolean;
}

interface ApiResponse<T = unknown> {
  code: number;
  msg?: string;
  token?: string;
  rows?: T[];
  data?: T;
}

const PASSWORD_KEY = 'cloudPassword';
const TOKEN_KEY = 'cloudToken';

export class FossibotCloud {
  token: string | null = null;
  readonly username: string;

  constructor(username: string) {
    this.username = username;
  }

  /** Restores the token/password saved in the iOS Keychain. */
  static async restore(username: string): Promise<FossibotCloud> {
    const c = new FossibotCloud(username);
    c.token = (await FossibotNet.keychainGet({ key: TOKEN_KEY })).value ?? null;
    return c;
  }

  async login(password?: string): Promise<void> {
    const pwd = password ?? (await FossibotNet.keychainGet({ key: PASSWORD_KEY })).value ?? null;
    if (!pwd) throw new Error('Потрібен пароль від акаунта Fossibot');
    const res = await this.raw<never>('POST', 'app/user/login', { username: this.username, password: pwd });
    if (res.code !== 200 || !res.token) throw new Error(res.msg || `Помилка входу (code ${res.code})`);
    this.token = res.token;
    await FossibotNet.keychainSet({ key: TOKEN_KEY, value: res.token });
    if (password) await FossibotNet.keychainSet({ key: PASSWORD_KEY, value: password });
  }

  async logout(): Promise<void> {
    this.token = null;
    await FossibotNet.keychainRemove({ key: TOKEN_KEY });
    await FossibotNet.keychainRemove({ key: PASSWORD_KEY });
  }

  async listDevices(): Promise<CloudDevice[]> {
    const res = await this.call<Record<string, unknown>>('GET', 'app/user_device/list', { pageNum: 1, pageSize: 50 });
    return (res.rows ?? []).map((d) => ({
      id: d.id as number,
      snCode: String(d.snCode ?? ''),
      deviceName: String(d.deviceName ?? d.snCode ?? ''),
      online: Boolean(d.state),
    }));
  }

  /** Same call the app makes when it has no local TCP session: GET app/ctrl/route?snCode&cmd. */
  async sendCommand(snCode: string, hex: string): Promise<void> {
    const res = await this.call('GET', 'app/ctrl/route', { snCode, cmd: hex.toLowerCase() });
    if (res.code !== 200) throw new Error(res.msg || `Сервер відхилив команду (code ${res.code})`);
  }

  wsHeaders(snCode: string): Record<string, string> {
    return { Authorization: `Bearer ${this.token ?? ''}`, lang: 'en-US', snCode };
  }

  /** Authenticated call; logs in again once on 401. */
  private async call<T>(method: 'GET' | 'POST', path: string, body: Record<string, unknown>): Promise<ApiResponse<T>> {
    if (!this.token) await this.login();
    let res = await this.raw<T>(method, path, body);
    if (res.code === 401) {
      await this.login();
      res = await this.raw<T>(method, path, body);
    }
    return res;
  }

  private async raw<T>(method: 'GET' | 'POST', path: string, body: Record<string, unknown>): Promise<ApiResponse<T>> {
    if (!isNative()) throw new Error('Режим «Сервер» працює лише в iOS-застосунку');
    const headers: Record<string, string> = { lang: 'en-US', 'Content-Type': 'application/json' };
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    const res = await CapacitorHttp.request({
      url: CLOUD_BASE + path,
      method,
      headers,
      ...(method === 'GET'
        ? { params: Object.fromEntries(Object.entries(body).map(([k, v]) => [k, String(v)])) }
        : { data: body }),
      connectTimeout: 15_000,
      readTimeout: 15_000,
    });
    if (res.status !== 200 && res.status !== 201) throw new Error(`HTTP ${res.status}`);
    return (typeof res.data === 'string' ? JSON.parse(res.data) : res.data) as ApiResponse<T>;
  }
}
