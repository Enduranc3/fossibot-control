import { createHubInfo } from '../components/hub-info.ts';
import { createNotifySettings } from '../components/notify-settings.ts';
import { createSettingRow } from '../components/setting-row.ts';
import type { UiDeps } from '../deps.ts';
import { DASH, describeAgent, fmtClock, fmtHex } from '../format.ts';
import { browserPushEnv } from '../push.ts';
import type { Page } from '../router.ts';
import { STATION_SETTINGS } from '../settings-def.ts';
import type { AppState } from '../store.ts';
import { h, setText } from '../ui/dom.ts';

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

function infoRows(st: AppState): [string, string][] {
  const snap = st.view?.snapshot;
  const r = snap?.registers ?? {};
  const str = (k: string) => (typeof r[k] === 'string' || typeof r[k] === 'number' ? String(r[k]) : DASH);
  const faults = snap ? [`BMS ${fmtHex(snap.faults.bms)}`, `PCS ${fmtHex(snap.faults.pcs)}`, `PV ${fmtHex(snap.faults.pv)}`] : [];
  const anyFault = !!snap && (snap.faults.bms || snap.faults.pcs || snap.faults.pv);
  return [
    ['Прошивка', str('firmwareVersion')],
    ['BMS', str('bmsVersion')],
    ['PCS / MPPT', str('pcsVersion')],
    ['Температура батареї', snap?.tempC != null ? `${snap.tempC} °C` : DASH],
    [
      'Вихід AC',
      snap?.acV != null && typeof r.acOutputFrequency === 'number' ? `${snap.acV.toFixed(1)} V · ${r.acOutputFrequency.toFixed(1)} Hz` : DASH,
    ],
    ['Помилки', snap ? (anyFault ? faults.join(' · ') : 'Немає') : DASH],
  ];
}

export function createSettingsPage(deps: UiDeps): Page {
  const rows = STATION_SETTINGS.map((d) => createSettingRow(d, deps));

  const capacity = h('input', { class: 'input-inline num', attrs: { type: 'number', inputmode: 'numeric', min: '200', max: '5000', step: '1', 'aria-label': 'Ємність батареї' } });
  capacity.addEventListener('change', () => {
    const v = Number(capacity.value);
    deps.api.updatePrefs({ capacityWh: v }).then(
      () => deps.notify('Ємність збережено'),
      (e: unknown) => {
        deps.notify(errorText(e), 'error');
        capacity.value = String(deps.store.get().view?.forecast.capacityWh ?? '');
      },
    );
  });

  const sessions = h('div', { class: 'sessions' });
  const loadSessions = () =>
    deps.api.sessions().then(
      (list) => {
        sessions.replaceChildren(
          ...list.map((s) => {
            const right = s.current
              ? h('span', { class: 'session-current', text: 'Цей пристрій' })
              : h('button', { class: 'link-inline', text: 'Завершити', attrs: { type: 'button', 'data-action': 'revoke' } });
            if (!s.current) {
              right.addEventListener('click', () => {
                deps.api.revokeSession(s.id).then(loadSessions, (e: unknown) => deps.notify(errorText(e), 'error'));
              });
            }
            return h('div', { class: 'kv' }, h('span', {}, describeAgent(s.userAgent), h('small', { text: ` · ${fmtClock(s.lastSeenTs)}` })), right);
          }),
        );
      },
      () => sessions.replaceChildren(h('div', { class: 'kv' }, h('span', { text: 'Не вдалося завантажити сеанси' }))),
    );
  void loadSessions();

  const logout = h('button', { class: 'link-danger', text: 'Вийти на цьому пристрої', attrs: { type: 'button', 'data-action': 'logout' } });
  logout.addEventListener('click', () => {
    deps.api.logout().finally(() => deps.onLoggedOut());
  });

  const info = h('div', { class: 'card list' });
  const notifications = createNotifySettings(deps, browserPushEnv());
  const hubInfo = createHubInfo(deps);

  const el = h(
    'div',
    { class: 'settings' },
    h('h2', { class: 'section-title', text: 'Станція' }),
    h('div', { class: 'card list' }, ...rows.map((r) => r.el)),
    h('h2', { class: 'section-title', text: 'Сповіщення' }),
    notifications.el,
    h('h2', { class: 'section-title', text: 'Хаб' }),
    h('div', { class: 'card list' }, h('div', { class: 'kv' }, h('span', { text: 'Ємність батареї' }), h('span', {}, capacity, ' Вт·год')), hubInfo.el, sessions, logout),
    h('h2', { class: 'section-title', text: 'Інформація' }),
    info,
  );

  const render = (st: AppState) => {
    for (const r of rows) r.update(st);
    if (document.activeElement !== capacity) capacity.value = String(st.view?.forecast.capacityWh ?? '');
    const pairs = infoRows(st);
    if (info.childElementCount !== pairs.length) {
      info.replaceChildren(...pairs.map(([k]) => h('div', { class: 'kv' }, h('span', { text: k }), h('span', { class: 'num' }))));
    }
    pairs.forEach(([, v], i) => setText(info.children[i].lastElementChild!, v));
  };
  render(deps.store.get());
  const unsubscribe = deps.store.subscribe(render);
  return { el, destroy: unsubscribe };
}
