// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { h, icon, ICONS, setText } from './dom.ts';
import { confirmSheet } from './sheet.ts';
import { toast } from './toast.ts';
import { easeOutCubic, tweenNumber } from './tween.ts';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

describe('dom', () => {
  it('builds elements with classes, text, attributes, listeners and children', () => {
    const click = vi.fn();
    const el = h('button', { class: 'a b', attrs: { type: 'button' }, on: { click } }, 'Go', null, false, h('span', { text: '!' }));
    el.click();
    expect(el.className).toBe('a b');
    expect(el.getAttribute('type')).toBe('button');
    expect(el.textContent).toBe('Go!');
    expect(click).toHaveBeenCalledTimes(1);
    setText(el, 'x');
    expect(el.textContent).toBe('x');
    expect(icon(ICONS.home).querySelectorAll('path').length).toBe(ICONS.home.length);
  });
});

describe('tween', () => {
  it('eases from 0 to 1 and jumps straight to the target with reduced motion', () => {
    expect(easeOutCubic(0)).toBe(0);
    expect(easeOutCubic(1)).toBe(1);
    vi.stubGlobal('matchMedia', () => ({ matches: true }));
    const el = h('span');
    tweenNumber(el, 10, 60, (v) => String(Math.round(v)));
    expect(el.textContent).toBe('60');
  });
});

describe('toast', () => {
  it('shows a message and removes it after the timeout', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const el = toast('Збережено', 'info', 1000);
    expect(document.body.textContent).toContain('Збережено');
    vi.advanceTimersByTime(1300);
    expect(el.isConnected).toBe(false);
  });
});

describe('confirmSheet', () => {
  const root = () => document.querySelector('.sheet-root');

  it('resolves true on confirm', async () => {
    const p = confirmSheet({ title: 'Вимкнути AC?', confirmText: 'Вимкнути', tone: 'danger' });
    (document.querySelector('.sheet-btn-danger') as HTMLButtonElement).click();
    expect(await p).toBe(true);
  });

  it('resolves false on cancel, backdrop and Escape', async () => {
    const a = confirmSheet({ title: 't', confirmText: 'ok' });
    (document.querySelector('.sheet-btn-ghost') as HTMLButtonElement).click();
    expect(await a).toBe(false);
    const b = confirmSheet({ title: 't', confirmText: 'ok' });
    (document.querySelectorAll('.sheet-backdrop')[1] as HTMLElement).click();
    expect(await b).toBe(false);
    const c = confirmSheet({ title: 't', confirmText: 'ok' });
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(await c).toBe(false);
    expect(root()).not.toBeNull(); // removed after the closing animation
  });
});
