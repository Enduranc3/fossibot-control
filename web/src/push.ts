import type { Api } from './api.ts';

export type PushState = 'unsupported' | 'needs-install' | 'denied' | 'off' | 'on';

export interface PushSub {
  endpoint: string;
  toJSON(): PushSubscriptionJSON;
  unsubscribe(): Promise<boolean>;
}

export interface PushRegistration {
  pushManager: {
    getSubscription(): Promise<PushSub | null>;
    subscribe(o: { userVisibleOnly: boolean; applicationServerKey: Uint8Array }): Promise<PushSub>;
  };
}

/** What the page needs from the browser, injectable for tests. */
export interface PushEnv {
  /** iPhone/iPad Safari outside the home-screen app: push needs the site installed first. */
  needsInstall: boolean;
  permission(): NotificationPermission | 'unsupported';
  requestPermission(): Promise<NotificationPermission>;
  registration(): Promise<PushRegistration | undefined>;
}

type PushApi = Pick<Api, 'pushKey' | 'pushSubscribe' | 'pushUnsubscribe'>;

export function browserPushEnv(): PushEnv {
  const nav = navigator as Navigator & { standalone?: boolean };
  const ios = /iPhone|iPad|iPod/.test(nav.userAgent) || (nav.platform === 'MacIntel' && nav.maxTouchPoints > 1);
  const standalone = nav.standalone === true || window.matchMedia?.('(display-mode: standalone)').matches === true;
  const hasPush = 'serviceWorker' in nav && 'PushManager' in window && 'Notification' in window;
  return {
    needsInstall: ios && !standalone,
    permission: () => (hasPush ? Notification.permission : 'unsupported'),
    requestPermission: () => Notification.requestPermission(),
    // `ready` never settles without a registered worker (dev server), hence the timeout.
    registration: async () =>
      hasPush
        ? Promise.race([
            nav.serviceWorker.ready as unknown as Promise<PushRegistration>,
            new Promise<undefined>((r) => setTimeout(() => r(undefined), 3000)),
          ])
        : undefined,
  };
}

export async function pushState(env: PushEnv): Promise<PushState> {
  if (env.needsInstall) return 'needs-install';
  const permission = env.permission();
  if (permission === 'unsupported') return 'unsupported';
  if (permission === 'denied') return 'denied';
  const reg = await env.registration();
  if (!reg) return 'unsupported';
  return (await reg.pushManager.getSubscription()) ? 'on' : 'off';
}

/** Must run straight from a tap: iOS only shows the permission prompt for a user gesture. */
export async function enablePush(env: PushEnv, api: PushApi): Promise<PushState> {
  const permission = await env.requestPermission();
  if (permission !== 'granted') return permission === 'denied' ? 'denied' : 'off';
  const reg = await env.registration();
  if (!reg) return 'unsupported';
  const { publicKey } = await api.pushKey();
  const sub =
    (await reg.pushManager.getSubscription()) ??
    (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToBytes(publicKey) }));
  await api.pushSubscribe(sub.toJSON());
  return 'on';
}

export async function disablePush(env: PushEnv, api: PushApi): Promise<PushState> {
  const sub = await (await env.registration())?.pushManager.getSubscription();
  if (sub) {
    await api.pushUnsubscribe(sub.endpoint).catch(() => undefined);
    await sub.unsubscribe();
  }
  return 'off';
}

export function urlBase64ToBytes(s: string): Uint8Array {
  const b64 = (s + '='.repeat((4 - (s.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}
