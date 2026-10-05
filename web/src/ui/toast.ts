import { h } from './dom.ts';

export type ToastTone = 'info' | 'error';

export function toast(message: string, tone: ToastTone = 'info', ms = 3200): HTMLElement {
  let host = document.getElementById('toasts');
  if (!host) {
    host = h('div', { class: 'toasts', attrs: { id: 'toasts', role: 'status', 'aria-live': 'polite' } });
    document.body.append(host);
  }
  const el = h('div', { class: `toast toast-${tone}`, text: message });
  host.append(el);
  requestAnimationFrame(() => el.classList.add('show'));
  setTimeout(() => {
    el.classList.remove('show');
    setTimeout(() => el.remove(), 250);
  }, ms);
  return el;
}
