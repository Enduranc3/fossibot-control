import './style.css';
import { FossibotCloud, type CloudDevice } from './cloud-api';
import {
  FossibotDriver,
  errorText,
  estimateMinutes,
  loadSavedConnection,
  saveConnection,
  type ConnectionMode,
  type ConnectionState,
  type PacketLogEntry,
  type StationTelemetry,
  type Transport,
} from './fossibot-driver';
import { isNative } from './native';
import { LedMode, SCREEN_TIMEOUT_OPTIONS, STANDBY_OPTIONS, hexToBytes } from './protocol';
import { CloudTransport, DemoTransport, LocalTcpTransport } from './transports';

const $ = <T extends HTMLElement = HTMLElement>(sel: string, root: ParentNode = document) => root.querySelector<T>(sel)!;
const $$ = <T extends HTMLElement = HTMLElement>(sel: string, root: ParentNode = document) =>
  Array.from(root.querySelectorAll<T>(sel));

const driver = new FossibotDriver();
let cloud: FossibotCloud | null = null;
let currentSn: string | null = null;

// ---------------------------------------------------------------- prefs

const CAPACITY_KEY = 'fossibot.capacityWh';
function capacityWh(): number {
  try {
    const v = Number(localStorage.getItem(CAPACITY_KEY));
    if (v > 0) return v;
  } catch {
    /* fall through */
  }
  return currentSn?.toUpperCase().startsWith('F300') ? 3072 : 1024;
}

// ---------------------------------------------------------------- toast

let toastTimer: ReturnType<typeof setTimeout> | undefined;
function toast(text: string, kind: 'info' | 'error' = 'info') {
  const el = $('#toast');
  el.textContent = text;
  el.style.color = kind === 'error' ? 'var(--color-bad)' : '';
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2800);
}

// ---------------------------------------------------------------- connection pill

const STATE_UI: Record<ConnectionState, { label: string; color: string; pulse?: boolean }> = {
  idle: { label: 'Не підключено', color: 'var(--color-muted)' },
  connecting: { label: 'Підключення…', color: 'var(--color-warn)', pulse: true },
  waiting: { label: 'Очікування станції', color: 'var(--color-warn)', pulse: true },
  connected: { label: 'Онлайн', color: 'var(--color-in)' },
  stale: { label: 'Немає даних', color: 'var(--color-warn)' },
  error: { label: 'Помилка', color: 'var(--color-bad)' },
};
const MODE_LABEL: Record<ConnectionMode, string> = { local: 'Wi-Fi', cloud: 'Сервер', demo: 'Демо' };

function renderState(state: ConnectionState, detail?: string) {
  const ui = STATE_UI[state];
  const dot = $('#connDot');
  dot.style.background = ui.color;
  dot.classList.toggle('pulse', !!ui.pulse);
  const mode = driver.mode;
  $('#connLabel').textContent = mode && state !== 'idle' ? `${MODE_LABEL[mode]} · ${ui.label}` : ui.label;
  const d = $('#connDetail');
  d.textContent = detail ?? '';
  d.classList.toggle('hidden', !detail || state === 'connected');
  $('#disconnectBtn').classList.toggle('hidden', state === 'idle');
  const live = state === 'connected' || state === 'stale';
  $$<HTMLButtonElement>('.toggle').forEach((b) => (b.disabled = !live));
}

// ---------------------------------------------------------------- telemetry

const RING_LEN = 2 * Math.PI * 104;

function socColors(soc: number): [string, string, string] {
  if (soc > 50) return ['#56d364', '#2ea043', 'rgb(63 185 80 / 0.55)'];
  if (soc > 20) return ['#e3b341', '#d29922', 'rgb(210 153 34 / 0.55)'];
  return ['#ff7b72', '#f85149', 'rgb(248 81 73 / 0.6)'];
}

function fmtMinutes(min: number | null): string {
  if (min === null || !isFinite(min)) return '—';
  if (min >= 6000) return '> 99 год';
  const h = Math.floor(min / 60);
  const m = Math.round(min % 60);
  return h ? `${h} год ${String(m).padStart(2, '0')} хв` : `${m} хв`;
}

function setText(sel: string, v: string | number) {
  const el = $(sel);
  const s = String(v);
  if (el.textContent !== s) el.textContent = s;
}

function renderTelemetry(t: StationTelemetry) {
  const soc = Math.max(0, Math.min(100, t.soc));
  setText('#socValue', Math.round(soc));
  const ring = $('#ringValue');
  ring.style.strokeDashoffset = String(RING_LEN * (1 - soc / 100));
  const [a, b, glow] = socColors(soc);
  $('#ringStopA').setAttribute('stop-color', a);
  $('#ringStopB').setAttribute('stop-color', b);
  ring.style.setProperty('--ring-glow', glow);

  const flow = $('#ringFlow');
  flow.classList.toggle('on', t.flow !== 'idle');
  flow.classList.toggle('reverse', t.flow === 'discharging');
  flow.setAttribute('stroke', t.flow === 'charging' ? '#3fb950' : '#ff9f43');

  const flowUi = {
    charging: { text: 'Заряджання', color: 'var(--color-in)', icon: '▲' },
    discharging: { text: 'Розряджання', color: 'var(--color-out)', icon: '▼' },
    idle: { text: 'Очікування', color: 'var(--color-muted)', icon: '■' },
  }[t.flow];
  setText('#flowText', flowUi.text);
  setText('#flowIcon', flowUi.icon);
  $('#flowLabel').style.color = flowUi.color;

  const est = estimateMinutes(t, capacityWh());
  const minutes = t.remainingMinutes && t.remainingMinutes > 0 ? t.remainingMinutes : est;
  setText('#etaLabel', t.flow === 'charging' ? 'До повного заряду' : t.flow === 'discharging' ? 'До розряду' : 'Час роботи');
  setText('#etaValue', t.flow === 'idle' ? '—' : fmtMinutes(minutes));

  setText('#inputW', t.inputW);
  setText('#outputW', t.outputW);
  setText('#acInW', t.acInputW);
  setText('#solarW', t.solarInputW);
  setText('#acOutW', t.acOutputW);
  setText('#dcUsbW', Math.round(t.dcOutputW + t.usbOutputW));

  renderToggle('ac', t.acOn, t.acOn ? 'Увімк' : 'Вимк');
  renderToggle('dc', t.dcOn, t.dcOn ? 'Увімк' : 'Вимк');
  renderToggle('usb', t.usbOn, t.usbOn ? 'Увімк' : 'Вимк');
  const ledNames = ['Вимк', 'Постійно', 'SOS', 'Стробоскоп'];
  renderToggle('led', t.led !== LedMode.Off, ledNames[t.led] ?? `Режим ${t.led}`);
  const ledModes = $('#ledModes');
  ledModes.classList.toggle('hidden', t.led === LedMode.Off);
  $$('button', ledModes).forEach((b) => b.setAttribute('aria-pressed', String(Number(b.dataset.led) === t.led)));
  // The official app hides the LED control on F3000 (SN prefix F300).
  $('[data-out="led"]').classList.toggle('hidden', !!currentSn?.toUpperCase().startsWith('F300'));

  renderSettings(t);
  renderDetails(t);
}

const pending = new Set<string>();
function renderToggle(id: string, on: boolean, label: string) {
  const el = $(`[data-out="${id}"]`);
  el.dataset.on = String(on);
  el.dataset.pending = String(pending.has(id));
  const state = $('.state', el);
  if (state.textContent !== label) state.textContent = label;
}

function renderSettings(t: StationTelemetry) {
  const r = t.registers;
  $$('#ecoSeg button').forEach((b) => b.setAttribute('aria-pressed', String(Number(b.dataset.eco) === (t.ecoMode ? 1 : 0))));
  for (const wrap of $$('[data-slider]')) {
    const input = $<HTMLInputElement>('input', wrap);
    if (document.activeElement === input || input.dataset.dragging === '1') continue;
    const v = r[wrap.dataset.slider!];
    if (typeof v === 'number') {
      input.value = String(v);
      paintSlider(wrap);
    }
  }
  for (const sel of $$<HTMLSelectElement>('[data-select]')) {
    const v = r[sel.dataset.select!];
    if (typeof v === 'number' && document.activeElement !== sel) sel.value = String(v);
  }
  for (const cb of $$<HTMLInputElement>('[data-check]')) {
    const v = r[cb.dataset.check!];
    if (typeof v === 'number') cb.checked = cb.dataset.invert ? v === 0 : v === 1;
  }
}

function paintSlider(wrap: HTMLElement) {
  const input = $<HTMLInputElement>('input', wrap);
  const min = Number(input.min);
  const max = Number(input.max);
  const v = Number(input.value);
  input.style.setProperty('--fill', `${((v - min) / (max - min)) * 100}%`);
  $('[data-val]', wrap).textContent = `${v}${wrap.dataset.unit ?? ''}`;
}

function renderDetails(t: StationTelemetry) {
  const rows: [string, string][] = [
    ['Напруга AC', t.acOutputVoltage !== null ? `${t.acOutputVoltage.toFixed(1)} V` : '—'],
    ['Частота AC', t.acOutputFrequency !== null ? `${t.acOutputFrequency.toFixed(1)} Hz` : '—'],
    ['Напруга батареї', t.packVoltage !== null ? `${t.packVoltage.toFixed(1)} V` : '—'],
    ['Темп. батареї', t.batteryTempMax !== null ? `${t.batteryTempMax} °C` : '—'],
    ['Ліміти заряду', t.chargeLimit !== null ? `${t.dischargeLimit ?? 0}–${t.chargeLimit}%` : '—'],
    ['Прошивка', t.firmwareVersion ?? '—'],
  ];
  const html = rows
    .map(([k, v]) => `<dt class="text-muted">${k}</dt><dd class="num text-right font-medium">${v}</dd>`)
    .join('');
  const dl = $('#details');
  if (dl.innerHTML !== html) dl.innerHTML = html;

  const f = t.faults;
  const faults = $('#faults');
  const any = f.bms || f.pcs || f.pv;
  faults.classList.toggle('hidden', !any);
  if (any) {
    const hex = (n: number) => `0x${n.toString(16).toUpperCase().padStart(8, '0')}`;
    faults.textContent = `Коди помилок: BMS ${hex(f.bms)} · PCS ${hex(f.pcs)} · PV ${hex(f.pv)}`;
  }
}

// ---------------------------------------------------------------- commands

async function run(id: string | null, fn: () => Promise<void>) {
  if (id) pending.add(id);
  if (driver.telemetry) renderTelemetry(driver.telemetry);
  try {
    await fn();
  } catch (e) {
    toast(errorText(e), 'error');
  } finally {
    if (id) setTimeout(() => {
      pending.delete(id);
      if (driver.telemetry) renderTelemetry(driver.telemetry);
    }, 1500);
  }
}

function wireControls() {
  $$('.toggle').forEach((el) =>
    el.addEventListener('click', () => {
      const t = driver.telemetry;
      if (!t) return;
      const id = el.dataset.out!;
      if (id === 'ac') run(id, () => driver.toggleAC(!t.acOn));
      if (id === 'dc') run(id, () => driver.toggleDC(!t.dcOn));
      if (id === 'usb') run(id, () => driver.toggleUSB(!t.usbOn));
      if (id === 'led') run(id, () => driver.setLed(t.led === LedMode.Off ? LedMode.On : LedMode.Off));
    }),
  );
  $$('#ledModes button').forEach((b) =>
    b.addEventListener('click', () => run('led', () => driver.setLed(Number(b.dataset.led) as LedMode))),
  );
  $$('#ecoSeg button').forEach((b) =>
    b.addEventListener('click', () => run(null, () => driver.setEcoMode(b.dataset.eco === '1'))),
  );

  for (const wrap of $$('[data-slider]')) {
    const input = $<HTMLInputElement>('input', wrap);
    input.min = wrap.dataset.min!;
    input.max = wrap.dataset.max!;
    input.step = wrap.dataset.step!;
    input.value = input.min;
    paintSlider(wrap);
    input.addEventListener('input', () => {
      input.dataset.dragging = '1';
      paintSlider(wrap);
    });
    input.addEventListener('change', () => {
      input.dataset.dragging = '';
      run(null, () => driver.setRegister(wrap.dataset.slider!, Number(input.value)));
    });
  }

  for (const sel of $$<HTMLSelectElement>('[data-select]')) {
    const opts = sel.dataset.options === 'screen' ? SCREEN_TIMEOUT_OPTIONS : STANDBY_OPTIONS;
    sel.innerHTML = opts.map((o, i) => `<option value="${i}">${o}</option>`).join('');
    sel.addEventListener('change', () => run(null, () => driver.setRegister(sel.dataset.select!, Number(sel.value))));
  }
  for (const cb of $$<HTMLInputElement>('[data-check]')) {
    cb.addEventListener('change', () => {
      const v = cb.dataset.invert ? (cb.checked ? 0 : 1) : cb.checked ? 1 : 0;
      run(null, () => driver.setRegister(cb.dataset.check!, v));
    });
  }

  const cap = $<HTMLInputElement>('#capacityInput');
  cap.value = String(capacityWh());
  cap.addEventListener('change', () => {
    try {
      if (Number(cap.value) > 0) localStorage.setItem(CAPACITY_KEY, cap.value);
      else localStorage.removeItem(CAPACITY_KEY);
    } catch {
      /* ignore */
    }
    if (driver.telemetry) renderTelemetry(driver.telemetry);
  });

  $('#settingsToggle').addEventListener('click', () => {
    const body = $('#settingsBody');
    body.classList.toggle('hidden');
    $('#settingsChev').style.transform = body.classList.contains('hidden') ? '' : 'rotate(180deg)';
  });
}

// ---------------------------------------------------------------- debug drawer

const LOG_MAX = 400;
let logCount = 0;
function appendLog(e: PacketLogEntry) {
  logCount++;
  $('#logCount').textContent = String(logCount);
  if ($<HTMLInputElement>('#pauseLog').checked) return;
  const isAck = e.text.endsWith('← ACK');
  const log = $('#log');
  const line = document.createElement('div');
  line.className = e.dir;
  if (isAck) line.dataset.ack = '1';
  line.hidden = isAck && $<HTMLInputElement>('#hideAck').checked;
  const time = new Date(e.at).toLocaleTimeString('uk-UA', { hour12: false });
  const tag = { tx: 'TX', rx: 'RX', info: '··', error: '!!' }[e.dir];
  line.textContent = `${time} ${tag} ${e.text}`;
  const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 24;
  log.appendChild(line);
  while (log.childElementCount > LOG_MAX) log.firstElementChild!.remove();
  if (atBottom) log.scrollTop = log.scrollHeight;
}

function wireDrawer() {
  const drawer = $('#drawer');
  $('#drawerHandle').addEventListener('click', () => {
    drawer.classList.toggle('open');
    $('#drawerTools').classList.toggle('hidden', !drawer.classList.contains('open'));
    const log = $('#log');
    log.scrollTop = log.scrollHeight;
  });
  $('#hideAck').addEventListener('change', (ev) => {
    const hide = (ev.target as HTMLInputElement).checked;
    $$('#log [data-ack]').forEach((l) => (l.hidden = hide));
  });
  $('#clearLog').addEventListener('click', () => {
    $('#log').innerHTML = '';
    logCount = 0;
    $('#logCount').textContent = '0';
  });
  $('#copyLog').addEventListener('click', async () => {
    const text = $$('#log div').map((d) => d.textContent).join('\n');
    try {
      await navigator.clipboard.writeText(text);
      toast('Лог скопійовано');
    } catch {
      toast('Не вдалося скопіювати', 'error');
    }
  });
  $('#rawSend').addEventListener('click', async () => {
    const input = $<HTMLInputElement>('#rawHex');
    const bytes = hexToBytes(input.value);
    if (!bytes.length) return;
    try {
      await driver.sendRaw(bytes);
    } catch (e) {
      toast(errorText(e), 'error');
    }
  });
}

// ---------------------------------------------------------------- connection sheet

function openSheet(open: boolean) {
  $('#sheet').classList.toggle('open', open);
  $('#sheetBackdrop').classList.toggle('open', open);
}

function selectMode(mode: ConnectionMode) {
  $$('#modeSeg button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.mode === mode)));
  $$('[data-pane]').forEach((p) => p.classList.toggle('hidden', p.dataset.pane !== mode));
  if (mode === 'cloud') renderCloudPane();
}

async function connectWith(transport: Transport, sn?: string, name?: string) {
  currentSn = sn ?? null;
  $('#deviceName').textContent = name ?? (sn || 'Fossibot');
  $<HTMLInputElement>('#capacityInput').value = String(capacityWh());
  saveConnection({ mode: transport.mode, snCode: sn, username: cloud?.username });
  openSheet(false);
  try {
    await driver.connect(transport);
  } catch (e) {
    toast(errorText(e), 'error');
  }
}

function connectLocal() {
  if (!isNative()) return toast('Режим Wi-Fi працює лише в iOS-застосунку', 'error');
  return connectWith(new LocalTcpTransport(), undefined, 'Станція (Wi-Fi)');
}

function renderCloudPane() {
  const logged = !!cloud?.token;
  $('#cloudLogin').classList.toggle('hidden', logged);
  $('#cloudDevices').classList.toggle('hidden', !logged);
  if (logged) {
    $('#cloudWho').textContent = cloud!.username;
    loadDevices();
  } else {
    const saved = loadSavedConnection();
    if (saved?.username) $<HTMLInputElement>('#cloudUser').value = saved.username;
  }
}

function cloudError(text: string | null) {
  const el = $('#cloudError');
  el.textContent = text ?? '';
  el.classList.toggle('hidden', !text);
}

async function loadDevices() {
  const list = $('#deviceList');
  list.innerHTML = '<p class="text-muted">Завантаження…</p>';
  cloudError(null);
  try {
    const devices = await cloud!.listDevices();
    if (!devices.length) {
      list.innerHTML = '<p class="text-muted">До акаунта не прив’язано жодної станції.</p>';
      return;
    }
    list.innerHTML = '';
    for (const d of devices) list.appendChild(deviceButton(d));
  } catch (e) {
    list.innerHTML = '';
    cloudError(errorText(e));
  }
}

function deviceButton(d: CloudDevice) {
  const b = document.createElement('button');
  b.className = 'btn btn-ghost flex w-full items-center justify-between !min-h-[56px]';
  b.innerHTML = `<span class="text-left"><span class="block font-semibold"></span><span class="block font-mono text-[12px] text-muted"></span></span>
    <span class="flex items-center gap-2 text-[12px] ${d.online ? 'text-in' : 'text-muted'}"><span class="pill-dot" style="background:currentColor"></span>${d.online ? 'онлайн' : 'офлайн'}</span>`;
  const [name, sn] = $$('span span', b);
  name.textContent = d.deviceName;
  sn.textContent = d.snCode;
  b.addEventListener('click', () => connectWith(new CloudTransport(cloud!, d.snCode), d.snCode, d.deviceName));
  return b;
}

function wireSheet() {
  $('#connPill').addEventListener('click', () => {
    selectMode(driver.mode ?? loadSavedConnection()?.mode ?? (isNative() ? 'local' : 'demo'));
    openSheet(true);
  });
  $('#sheetBackdrop').addEventListener('click', () => openSheet(false));
  $$('#modeSeg button').forEach((b) => b.addEventListener('click', () => selectMode(b.dataset.mode as ConnectionMode)));
  $('[data-connect="local"]').addEventListener('click', connectLocal);
  $('[data-connect="demo"]').addEventListener('click', () => connectWith(new DemoTransport(), 'F1800DEMO', 'F1800 · демо'));
  $('#disconnectBtn').addEventListener('click', async () => {
    await driver.disconnect();
    saveConnection(null);
    openSheet(false);
  });

  $('#cloudLoginBtn').addEventListener('click', async () => {
    const user = $<HTMLInputElement>('#cloudUser').value.trim();
    const pass = $<HTMLInputElement>('#cloudPass').value;
    if (!user || !pass) return cloudError('Введіть email і пароль');
    const btn = $<HTMLButtonElement>('#cloudLoginBtn');
    btn.disabled = true;
    cloudError(null);
    try {
      cloud = new FossibotCloud(user);
      await cloud.login(pass);
      $<HTMLInputElement>('#cloudPass').value = '';
      saveConnection({ ...(loadSavedConnection() ?? { mode: 'cloud' }), username: user });
      renderCloudPane();
    } catch (e) {
      cloud = null;
      cloudError(errorText(e));
    } finally {
      btn.disabled = false;
    }
  });
  $('#cloudLogout').addEventListener('click', async () => {
    if (driver.mode === 'cloud') await driver.disconnect();
    await cloud?.logout();
    cloud = null;
    renderCloudPane();
  });
}

// ---------------------------------------------------------------- boot

async function autoConnect() {
  if (new URLSearchParams(location.search).has('demo')) {
    return connectWith(new DemoTransport(), 'F1800DEMO', 'F1800 · демо');
  }
  const saved = loadSavedConnection();
  if (!saved) {
    selectMode(isNative() ? 'local' : 'demo');
    openSheet(true);
    return;
  }
  if (saved.username && isNative()) {
    try {
      cloud = await FossibotCloud.restore(saved.username);
    } catch {
      cloud = null;
    }
  }
  if (saved.mode === 'demo') return connectWith(new DemoTransport(), 'F1800DEMO', 'F1800 · демо');
  if (!isNative()) return;
  if (saved.mode === 'local') return connectLocal();
  if (saved.mode === 'cloud' && cloud && saved.snCode) {
    return connectWith(new CloudTransport(cloud, saved.snCode), saved.snCode, saved.snCode);
  }
}

driver.on('state', ({ state, detail }) => renderState(state, detail));
driver.on('telemetry', renderTelemetry);
driver.on('packet', appendLog);
wireControls();
wireDrawer();
wireSheet();
renderState('idle');
autoConnect();

// iOS suspends the app in the background; reconnect when it comes back if the link died.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  if (driver.state === 'error' || driver.state === 'stale') {
    const saved = loadSavedConnection();
    if (saved) autoConnect();
  }
});
