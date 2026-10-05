import { api, type Api } from '../api.ts';
import type { Page } from '../router.ts';
import { h, s } from '../ui/dom.ts';

function logo(): SVGSVGElement {
  return s(
    'svg',
    { viewBox: '0 0 64 64', class: 'auth-logo', 'aria-hidden': 'true' },
    s('circle', { cx: 32, cy: 32, r: 26, fill: 'none', stroke: '#1c2123', 'stroke-width': 6 }),
    s('circle', {
      cx: 32,
      cy: 32,
      r: 26,
      fill: 'none',
      stroke: '#34d17a',
      'stroke-width': 6,
      'stroke-linecap': 'round',
      'stroke-dasharray': '120 164',
      transform: 'rotate(-90 32 32)',
    }),
    s('path', { d: 'M35 18 25 34h7l-3 12 10-16h-7l3-12z', fill: '#eef2f3' }),
  );
}

export function createAuthPage(opts: { setUp: boolean; onDone(): void; client?: Pick<Api, 'setup' | 'login'> }): Page {
  const client = opts.client ?? api;
  const isSetup = !opts.setUp;
  const pass = h('input', {
    class: 'field',
    attrs: { type: 'password', placeholder: isSetup ? 'Новий пароль' : 'Пароль', autocomplete: isSetup ? 'new-password' : 'current-password', 'aria-label': 'Пароль' },
  });
  const repeat = isSetup
    ? h('input', { class: 'field', attrs: { type: 'password', placeholder: 'Повторіть пароль', autocomplete: 'new-password', 'aria-label': 'Повторіть пароль' } })
    : null;
  const error = h('div', { class: 'form-error', attrs: { role: 'alert' } });
  const submit = h('button', { class: 'btn-primary', text: isSetup ? 'Задати пароль' : 'Увійти', attrs: { type: 'submit' } });
  const form = h('form', { class: 'auth-card', attrs: { novalidate: '' } },
    logo(),
    h('h1', { class: 'auth-title', text: 'Fossibot' }),
    h('p', { class: 'auth-sub', text: isSetup ? 'Задайте пароль для доступу до хаба' : 'Увійдіть, щоб керувати станцією' }),
    pass,
    repeat,
    error,
    submit,
  );

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    error.textContent = '';
    if (isSetup) {
      if (pass.value.length < 8) return void (error.textContent = 'Пароль — щонайменше 8 символів');
      if (pass.value !== repeat?.value) return void (error.textContent = 'Паролі не збігаються');
    } else if (!pass.value) {
      return void (error.textContent = 'Введіть пароль');
    }
    submit.disabled = true;
    const call = isSetup ? client.setup(pass.value) : client.login(pass.value);
    call.then(
      () => opts.onDone(),
      (err: unknown) => {
        error.textContent = err instanceof Error ? err.message : String(err);
        submit.disabled = false;
        pass.select();
      },
    );
  });

  const el = h('div', { class: 'auth' }, form);
  queueMicrotask(() => pass.focus());
  return { el };
}
