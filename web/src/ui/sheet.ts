import { h } from './dom.ts';

export interface ConfirmOptions {
  title: string;
  body?: string;
  confirmText: string;
  cancelText?: string;
  tone?: 'danger' | 'default';
}

/** Bottom sheet asking for confirmation; resolves false on cancel, backdrop tap or Escape. */
export function confirmSheet(o: ConfirmOptions): Promise<boolean> {
  return new Promise((resolve) => {
    const host = document.getElementById('overlays') ?? document.body;
    const confirmBtn = h('button', {
      class: `sheet-btn ${o.tone === 'danger' ? 'sheet-btn-danger' : 'sheet-btn-primary'}`,
      text: o.confirmText,
      attrs: { type: 'button' },
    });
    const cancelBtn = h('button', { class: 'sheet-btn sheet-btn-ghost', text: o.cancelText ?? 'Скасувати', attrs: { type: 'button' } });
    const backdrop = h('div', { class: 'sheet-backdrop' });
    const panel = h(
      'div',
      { class: 'sheet', attrs: { role: 'dialog', 'aria-modal': 'true', 'aria-label': o.title } },
      h('div', { class: 'sheet-grabber' }),
      h('h2', { class: 'sheet-title', text: o.title }),
      o.body ? h('p', { class: 'sheet-body', text: o.body }) : null,
      h('div', { class: 'sheet-actions' }, confirmBtn, cancelBtn),
    );
    const root = h('div', { class: 'sheet-root' }, backdrop, panel);
    let done = false;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close(false);
    };
    const close = (result: boolean) => {
      if (done) return;
      done = true;
      root.classList.remove('open');
      document.removeEventListener('keydown', onKey);
      setTimeout(() => root.remove(), 280);
      resolve(result);
    };
    confirmBtn.addEventListener('click', () => close(true));
    cancelBtn.addEventListener('click', () => close(false));
    backdrop.addEventListener('click', () => close(false));
    document.addEventListener('keydown', onKey);
    host.append(root);
    requestAnimationFrame(() => root.classList.add('open'));
    confirmBtn.focus();
  });
}
