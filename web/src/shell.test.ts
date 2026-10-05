// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from './api.ts';
import { mountShell } from './app.ts';
import { createAuthPage } from './pages/auth.ts';
import { Router } from './router.ts';
import { createAppStore } from './store.ts';
import { h } from './ui/dom.ts';

afterEach(() => {
  document.body.innerHTML = '';
  location.hash = '';
});

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('Router', () => {
  it('renders the route for the hash, falls back to home and destroys the old page', () => {
    const outlet = h('main');
    const destroyed = vi.fn();
    const changes: string[] = [];
    const r = new Router(
      outlet,
      { '/': () => ({ el: h('div', { text: 'home' }), destroy: destroyed }), '/settings': () => ({ el: h('div', { text: 'settings' }) }) },
      (p) => changes.push(p),
    );
    location.hash = '#/settings';
    r.start();
    expect(outlet.textContent).toBe('settings');
    location.hash = '#/nope';
    window.dispatchEvent(new HashChangeEvent('hashchange'));
    expect(outlet.textContent).toBe('home');
    location.hash = '#/settings';
    window.dispatchEvent(new HashChangeEvent('hashchange'));
    expect(destroyed).toHaveBeenCalledTimes(1);
    expect(changes).toEqual(['/settings', '/', '/settings']);
    r.stop();
    expect(Router.pathOf('')).toBe('/');
  });
});

describe('shell', () => {
  it('shows connection state and the offline banner with the time of the last data', () => {
    const store = createAppStore();
    const root = h('div');
    const shell = mountShell(root, store);
    const banner = root.querySelector('.banner') as HTMLElement;
    expect(banner.hidden).toBe(true);
    store.set({ hub: 'offline', lastDataAt: Date.UTC(2026, 9, 6, 11, 32) });
    expect(banner.hidden).toBe(false);
    expect(banner.textContent).toBe("Немає зв'язку з хабом · останні дані о 14:32");
    store.set({ hub: 'offline', lastDataAt: null });
    expect(banner.textContent).toBe("Немає зв'язку з хабом");
    store.set({ hub: 'online' });
    expect(banner.hidden).toBe(true);
    expect(root.querySelector('[data-conn="hub"] .dot')?.getAttribute('data-state')).toBe('ok');
    store.set({ view: { link: 'down' } as never });
    expect(root.querySelector('[data-conn="station"] .dot')?.getAttribute('data-state')).toBe('bad');
    shell.setActive('/settings');
    expect(root.querySelector('[aria-current="page"]')?.textContent).toContain('Налаштування');
    shell.destroy();
  });
});

describe('auth page', () => {
  const fill = (page: HTMLElement, values: string[]) => {
    page.querySelectorAll('input').forEach((input, i) => (input.value = values[i] ?? ''));
    page.querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true }));
  };

  it('validates the new password before calling the hub', async () => {
    const client = { setup: vi.fn(async () => ({ ok: true as const })), login: vi.fn() };
    const done = vi.fn();
    const { el } = createAuthPage({ setUp: false, onDone: done, client });
    fill(el, ['short', 'short']);
    expect(el.querySelector('.form-error')?.textContent).toBe('Пароль — щонайменше 8 символів');
    fill(el, ['long enough', 'different!']);
    expect(el.querySelector('.form-error')?.textContent).toBe('Паролі не збігаються');
    expect(client.setup).not.toHaveBeenCalled();
    fill(el, ['long enough', 'long enough']);
    await flush();
    expect(client.setup).toHaveBeenCalledWith('long enough');
    expect(done).toHaveBeenCalledTimes(1);
  });

  it('shows hub errors on login and re-enables the button', async () => {
    const client = { setup: vi.fn(), login: vi.fn(async () => Promise.reject(new ApiError(401, 'wrong_password', 'Невірний пароль'))) };
    const { el } = createAuthPage({ setUp: true, onDone: vi.fn(), client });
    expect(el.querySelectorAll('input')).toHaveLength(1);
    fill(el, ['whatever1']);
    await flush();
    expect(el.querySelector('.form-error')?.textContent).toBe('Невірний пароль');
    expect((el.querySelector('button[type="submit"]') as HTMLButtonElement).disabled).toBe(false);
  });
});
