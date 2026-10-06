import type { UiDeps } from '../deps.ts';
import { disablePush, enablePush, pushState, type PushEnv, type PushState } from '../push.ts';
import type { Prefs } from '../types.ts';
import { h, setText } from '../ui/dom.ts';

type Kind = keyof Prefs['notify'];

export const NOTIFY_LABELS: readonly (readonly [Kind, string])[] = [
  ['grid_lost', 'Зникло світло'],
  ['grid_restored', 'Світло повернулось'],
  ['soc_low', 'Низький заряд'],
  ['link_lost', "Втрачено зв'язок зі станцією (понад 2 хв)"],
  ['fault_set', 'Помилки станції'],
  ['output_changed', 'Увімкнення й вимкнення виходів'],
  ['setting_changed', 'Зміни налаштувань станції'],
  ['hub_started', 'Перезапуск хаба'],
];

const STATE_TEXT: Record<PushState, string> = {
  on: 'Увімкнено на цьому пристрої',
  off: 'Вимкнено на цьому пристрої',
  'needs-install': 'Щоб отримувати сповіщення, додайте сайт через «Поділитися → На початковий екран» і відкрийте його звідти',
  denied: 'Сповіщення заборонені — дозвольте їх у налаштуваннях iPhone',
  unsupported: 'Цей браузер не підтримує сповіщення',
};

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function createNotifySettings(deps: UiDeps, env: PushEnv) {
  let state: PushState | null = null;
  let prefs: Prefs | null = null;

  const status = h('span', { class: 'notify-status', text: 'Перевіряємо…' });
  const toggle = h('button', { class: 'btn-small', text: 'Увімкнути', attrs: { type: 'button', 'data-action': 'push-toggle' } });
  toggle.hidden = true;
  const test = h('button', { class: 'link-accent', text: 'Надіслати тестове', attrs: { type: 'button', 'data-action': 'push-test' } });
  const testRow = h('div', { class: 'kv', attrs: { 'data-row': 'push-test' } }, h('span', { text: 'Перевірка' }), test);
  testRow.hidden = true;
  const switches = NOTIFY_LABELS.map(([kind, label]) => {
    const sw = h('button', { class: 'switch', attrs: { type: 'button', role: 'switch', 'aria-checked': 'false', 'aria-label': label, 'data-kind': kind } });
    sw.disabled = true;
    sw.addEventListener('click', () => void setKind(kind, sw.getAttribute('aria-checked') !== 'true'));
    return { kind, sw, el: h('div', { class: 'kv' }, h('span', { text: label }), sw) };
  });
  const threshold = h('input', {
    class: 'input-inline num',
    attrs: { type: 'number', inputmode: 'numeric', min: '5', max: '80', step: '1', 'aria-label': 'Поріг низького заряду' },
  });
  const el = h(
    'div',
    { class: 'card list notify' },
    h('div', { class: 'kv notify-head' }, status, toggle),
    testRow,
    ...switches.map((s) => s.el),
    h('div', { class: 'kv' }, h('span', { text: 'Поріг низького заряду' }), h('span', {}, threshold, ' %')),
  );

  function render() {
    setText(status, state ? STATE_TEXT[state] : 'Перевіряємо…');
    toggle.hidden = state !== 'on' && state !== 'off';
    setText(toggle, state === 'on' ? 'Вимкнути' : 'Увімкнути');
    testRow.hidden = state !== 'on';
    for (const s of switches) {
      s.sw.setAttribute('aria-checked', String(prefs?.notify[s.kind] ?? false));
      s.sw.disabled = !prefs;
    }
    if (prefs && document.activeElement !== threshold) threshold.value = String(prefs.socLowThreshold);
  }

  async function savePrefs(patch: Partial<Prefs>, optimistic: Prefs) {
    const before = prefs;
    prefs = optimistic;
    render();
    try {
      prefs = await deps.api.updatePrefs(patch);
    } catch (e) {
      prefs = before;
      deps.notify(errorText(e), 'error');
    }
    render();
  }

  function setKind(kind: Kind, on: boolean) {
    if (!prefs) return;
    return savePrefs({ notify: { [kind]: on } } as unknown as Partial<Prefs>, { ...prefs, notify: { ...prefs.notify, [kind]: on } });
  }

  threshold.addEventListener('change', () => {
    if (!prefs) return;
    const v = Number(threshold.value);
    void savePrefs({ socLowThreshold: v }, { ...prefs, socLowThreshold: v });
  });

  toggle.addEventListener('click', () => {
    toggle.disabled = true;
    // enablePush asks for permission first thing, still inside this tap (iOS requires it).
    const run = state === 'on' ? disablePush(env, deps.api) : enablePush(env, deps.api);
    run
      .then(
        (s) => {
          state = s;
          if (s === 'denied') deps.notify(STATE_TEXT.denied, 'error');
        },
        (e: unknown) => deps.notify(errorText(e), 'error'),
      )
      .finally(() => {
        toggle.disabled = false;
        render();
      });
  });

  test.addEventListener('click', () => {
    deps.api.pushTest().then(
      (r) => deps.notify(r.sent ? 'Тестове сповіщення надіслано' : 'Жоден пристрій не отримав сповіщення', r.sent ? 'info' : 'error'),
      (e: unknown) => deps.notify(errorText(e), 'error'),
    );
  });

  async function refresh() {
    state = await pushState(env).catch((): PushState => 'unsupported');
    render();
  }

  deps.api.prefs().then(
    (p) => {
      prefs = p;
      render();
    },
    () => {},
  );
  void refresh();
  render();
  return { el, refresh };
}
