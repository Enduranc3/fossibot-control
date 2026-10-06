// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createNotifySettings } from './components/notify-settings.ts';
import type { UiDeps } from './deps.ts';
import { disablePush, enablePush, pushState, urlBase64ToBytes, type PushEnv, type PushRegistration, type PushSub } from './push.ts';
import { createAppStore } from './store.ts';
import type { Prefs } from './types.ts';

afterEach(() => document.body.replaceChildren());
const flush = () => new Promise((r) => setTimeout(r, 0));

function fakeEnv(o: { needsInstall?: boolean; permission?: NotificationPermission | 'unsupported'; subscribed?: boolean; grant?: NotificationPermission } = {}) {
  let sub: PushSub | null = null;
  const makeSub = (): PushSub => ({
    endpoint: 'https://web.push.apple.com/x',
    toJSON: () => ({ endpoint: 'https://web.push.apple.com/x', keys: { p256dh: 'p', auth: 'a' } }),
    unsubscribe: vi.fn(async () => {
      sub = null;
      return true;
    }),
  });
  if (o.subscribed) sub = makeSub();
  let permission = o.permission ?? (o.subscribed ? 'granted' : 'default');
  const subscribe = vi.fn(async () => (sub = makeSub()));
  const reg: PushRegistration = { pushManager: { getSubscription: async () => sub, subscribe } };
  const env: PushEnv = {
    needsInstall: o.needsInstall ?? false,
    permission: () => permission,
    requestPermission: vi.fn(async () => {
      permission = o.grant ?? 'granted';
      return permission;
    }),
    registration: async () => reg,
  };
  return { env, subscribe, current: () => sub };
}

const KEY = 'BOtTUSwJjfSyJvVx0iL0-AKcOuF0GSlXvj8pk-jLdFFqKzh2u0gvzcMuuCeO3mlqylQQh0rSNz9e2VKKYzfAsdk';
const PREFS: Prefs = {
  socLowThreshold: 20,
  capacityWh: 1024,
  notify: { grid_lost: true, grid_restored: true, soc_low: true, link_lost: true, fault_set: true, output_changed: false, setting_changed: false, hub_started: false },
};

function deps(over: Record<string, unknown> = {}) {
  const api = {
    pushKey: vi.fn(async () => ({ publicKey: KEY })),
    pushSubscribe: vi.fn(async () => ({ ok: true })),
    pushUnsubscribe: vi.fn(async () => ({ ok: true })),
    pushTest: vi.fn(async () => ({ sent: 1 })),
    prefs: vi.fn(async () => PREFS),
    updatePrefs: vi.fn(async (patch: Partial<Prefs>) => ({ ...PREFS, ...patch, notify: { ...PREFS.notify, ...(patch.notify ?? {}) } })),
    ...over,
  };
  const d = { store: createAppStore(), api, run: vi.fn(), confirm: vi.fn(), notify: vi.fn(), onLoggedOut: vi.fn() } as unknown as UiDeps;
  return { d, api, notify: d.notify as ReturnType<typeof vi.fn> };
}

describe('push in the browser', () => {
  it('knows when the site must be added to the home screen, is blocked, unsupported, off or on', async () => {
    expect(await pushState(fakeEnv({ needsInstall: true }).env)).toBe('needs-install');
    expect(await pushState(fakeEnv({ permission: 'denied' }).env)).toBe('denied');
    expect(await pushState(fakeEnv({ permission: 'unsupported' }).env)).toBe('unsupported');
    expect(await pushState(fakeEnv().env)).toBe('off');
    expect(await pushState(fakeEnv({ subscribed: true }).env)).toBe('on');
  });

  it('decodes the server key', () => {
    expect([...urlBase64ToBytes('AQID')]).toEqual([1, 2, 3]);
    expect([...urlBase64ToBytes('-_8')]).toEqual([251, 255]);
    expect(urlBase64ToBytes(KEY)).toHaveLength(65);
  });

  it('subscribes with the hub key after permission and tells the hub', async () => {
    const f = fakeEnv();
    const { d, api } = deps();
    expect(await enablePush(f.env, d.api)).toBe('on');
    expect(f.subscribe).toHaveBeenCalledWith({ userVisibleOnly: true, applicationServerKey: urlBase64ToBytes(KEY) });
    expect(api.pushSubscribe).toHaveBeenCalledWith({ endpoint: 'https://web.push.apple.com/x', keys: { p256dh: 'p', auth: 'a' } });
  });

  it('stops when permission is refused', async () => {
    const f = fakeEnv({ grant: 'denied' });
    const { d, api } = deps();
    expect(await enablePush(f.env, d.api)).toBe('denied');
    expect(f.subscribe).not.toHaveBeenCalled();
    expect(api.pushSubscribe).not.toHaveBeenCalled();
  });

  it('unsubscribes here and at the hub', async () => {
    const f = fakeEnv({ subscribed: true });
    const { d, api } = deps();
    expect(await disablePush(f.env, d.api)).toBe('off');
    expect(api.pushUnsubscribe).toHaveBeenCalledWith('https://web.push.apple.com/x');
    expect(f.current()).toBeNull();
  });
});

describe('notification settings', () => {
  async function mount(envOpts: Parameters<typeof fakeEnv>[0] = {}, over: Record<string, unknown> = {}) {
    const f = fakeEnv(envOpts);
    const x = deps(over);
    const c = createNotifySettings(x.d, f.env);
    document.body.append(c.el);
    await flush();
    await flush();
    return { ...x, ...f, el: c.el };
  }

  it('shows one switch per kind from the hub preferences', async () => {
    const { el } = await mount();
    const switches = [...el.querySelectorAll('.switch[data-kind]')];
    expect(switches).toHaveLength(8);
    expect(el.querySelector('[data-kind="grid_lost"]')?.getAttribute('aria-checked')).toBe('true');
    expect(el.querySelector('[data-kind="output_changed"]')?.getAttribute('aria-checked')).toBe('false');
    expect((el.querySelector('input[aria-label="Поріг низького заряду"]') as HTMLInputElement).value).toBe('20');
  });

  it('saves a switch and puts it back when saving fails', async () => {
    const { el, api, notify } = await mount();
    (el.querySelector('[data-kind="output_changed"]') as HTMLButtonElement).click();
    await flush();
    expect(api.updatePrefs).toHaveBeenCalledWith({ notify: { output_changed: true } });
    expect(el.querySelector('[data-kind="output_changed"]')?.getAttribute('aria-checked')).toBe('true');
    api.updatePrefs.mockRejectedValueOnce(new Error('Недопустиме значення'));
    (el.querySelector('[data-kind="soc_low"]') as HTMLButtonElement).click();
    await flush();
    expect(el.querySelector('[data-kind="soc_low"]')?.getAttribute('aria-checked')).toBe('true');
    expect(notify).toHaveBeenCalledWith('Недопустиме значення', 'error');
  });

  it('turns push on for this device and sends a test', async () => {
    const { el, api, notify } = await mount();
    expect(el.querySelector('.notify-status')?.textContent).toBe('Вимкнено на цьому пристрої');
    expect((el.querySelector('[data-row="push-test"]') as HTMLElement).hidden).toBe(true);
    (el.querySelector('[data-action="push-toggle"]') as HTMLButtonElement).click();
    await flush();
    await flush();
    expect(el.querySelector('.notify-status')?.textContent).toBe('Увімкнено на цьому пристрої');
    expect(el.querySelector('[data-action="push-toggle"]')?.textContent).toBe('Вимкнути');
    (el.querySelector('[data-action="push-test"]') as HTMLButtonElement).click();
    await flush();
    expect(api.pushTest).toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith('Тестове сповіщення надіслано', 'info');
  });

  it('explains how to get notifications in Safari outside the home-screen app', async () => {
    const { el } = await mount({ needsInstall: true });
    expect(el.querySelector('.notify-status')?.textContent).toContain('На початковий екран');
    expect((el.querySelector('[data-action="push-toggle"]') as HTMLElement).hidden).toBe(true);
  });
});
