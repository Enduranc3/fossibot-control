// UI check: runs the built site against a hub + station simulator in Chromium and WebKit at iPhone size,
// takes screenshots of every screen and state, and measures layout shifts and long tasks.
// usage: node scripts/ui-check.mjs [outDir]
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium, webkit } from 'playwright';
import { startHub } from '../hub/src/hub.ts';
import { StationSimulator } from '../tools/station-sim.ts';

const out = resolve(process.argv[2] ?? 'ui-check');
mkdirSync(out, { recursive: true });
const PASSWORD = 'ui-check-password';

const hub = await startHub({
  dataDir: mkdtempSync(join(tmpdir(), 'ui-check-')),
  httpHost: '127.0.0.1',
  httpPort: 0,
  stationHost: '127.0.0.1',
  stationPort: 0,
  allowedStationPrefix: '127.0.0.',
  allowedOrigins: [],
  webDir: resolve('dist/web'),
  gridRule: { lost: (s) => s.acInW <= 2 && s.outW > s.inW, restored: (s) => s.acInW > 2, lostAfterSec: 2, restoredAfterSec: 2 },
  log: () => {},
});
const sim = new StationSimulator({ port: hub.stationPort, intervalMs: 500 });
await sim.connect();
const base = `http://127.0.0.1:${hub.httpPort}`;
const report = { base, browsers: {} };
let failed = false;

const PERF = `
  window.__perf = { cls: 0, longest: 0 };
  new PerformanceObserver((l) => { for (const e of l.getEntries()) if (!e.hadRecentInput) window.__perf.cls += e.value; }).observe({ type: 'layout-shift', buffered: true });
  new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__perf.longest = Math.max(window.__perf.longest, e.duration); }).observe({ type: 'longtask', buffered: true });
`;

for (const [name, type] of [
  ['chromium', chromium],
  ['webkit', webkit],
]) {
  const browser = await type.launch();
  const ctx = await browser.newContext({
    viewport: { width: 393, height: 852 },
    deviceScaleFactor: 3,
    isMobile: name === 'chromium',
    hasTouch: true,
    colorScheme: 'dark',
    locale: 'uk-UA',
    timezoneId: 'Europe/Kyiv',
  });
  if (name === 'chromium') await ctx.addInitScript(PERF);
  const page = await ctx.newPage();
  const errors = [];
  let disconnecting = false; // the hub-offline step drops the socket on purpose
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    if (disconnecting && /WebSocket/.test(m.text())) return;
    errors.push(m.text());
  });
  let n = 0;
  const shot = async (label) => page.screenshot({ path: join(out, `${name}-${String(++n).padStart(2, '0')}-${label}.png`), fullPage: true });
  const issues = [];
  const checkText = async (label) => {
    const text = await page.evaluate(() => document.body.innerText);
    if (/NaN|undefined/.test(text)) issues.push(`${label}: NaN/undefined in text`);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
    if (overflow) issues.push(`${label}: horizontal overflow`);
  };

  await page.goto(base);
  await page.waitForSelector('.auth-card');
  await shot('auth');
  // First browser sets the password (two fields), the second one logs in (one field).
  const fields = page.locator('input[type="password"]');
  const count = await fields.count();
  for (let i = 0; i < count; i++) await fields.nth(i).fill(PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForSelector('.gauge[data-tone="ok"]', { timeout: 15_000 });
  await page.waitForTimeout(1200);
  await shot('home');
  await checkText('home');

  await page.click('[data-output="acOn"]');
  await page.waitForSelector('.sheet-root.open');
  await page.waitForTimeout(350);
  await shot('ac-confirm');
  await page.click('.sheet-btn-ghost');
  // The station keeps its state between browsers: only switch on what is still off.
  if ((await page.getAttribute('[data-output="dcOn"]', 'data-on')) !== 'true') await page.click('[data-output="dcOn"]');
  await page.waitForSelector('[data-output="dcOn"][data-on="true"]', { timeout: 10_000 });
  if ((await page.getAttribute('[data-output="led"]', 'data-on')) !== 'true') await page.click('[data-output="led"]');
  await page.waitForSelector('.led-modes:not([hidden])', { timeout: 10_000 });
  await page.waitForTimeout(400);
  await shot('outputs-on');
  const bottom = async (label) => {
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    await page.waitForTimeout(300);
    await page.screenshot({ path: join(out, `${name}-${String(++n).padStart(2, '0')}-${label}.png`) });
    await page.evaluate(() => window.scrollTo(0, 0));
  };
  await bottom('home-bottom');

  sim.setGrid(false);
  await page.waitForSelector('text=Відключення', { timeout: 15_000 });
  await page.waitForTimeout(800);
  await shot('outage');
  await checkText('outage');
  sim.setGrid(true);

  await page.click('a[href="#/settings"]');
  await page.waitForSelector('.settings');
  await page.waitForTimeout(600);
  await shot('settings');
  await bottom('settings-bottom');
  await checkText('settings');

  // Hub unreachable: refuse new live sockets and drop the open one on the hub side.
  await page.click('a[href="#/"]');
  disconnecting = true;
  await page.routeWebSocket(/\/api\/live/, (ws) => ws.close());
  for (const client of hub.live['wss'].clients) client.terminate();
  await page.waitForSelector('.banner:not([hidden])', { timeout: 30_000 });
  await page.waitForTimeout(400);
  await shot('hub-offline');
  await checkText('hub-offline');

  const perf = name === 'chromium' ? await page.evaluate(() => window.__perf) : null;
  if (perf && (perf.cls > 0.05 || perf.longest > 200)) issues.push(`perf: cls=${perf.cls.toFixed(3)} longest=${perf.longest}ms`);
  report.browsers[name] = { errors, issues, perf };
  if (errors.length || issues.length) failed = true;
  await browser.close();
}

writeFileSync(join(out, 'report.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
sim.disconnect();
await hub.stop();
process.exit(failed ? 1 : 0);
