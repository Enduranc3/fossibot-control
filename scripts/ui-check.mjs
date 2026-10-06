// UI check: runs the built site against a hub + station simulator in Chromium and WebKit at iPhone size,
// takes screenshots of every screen and state, and measures layout shifts and long tasks.
// usage: node scripts/ui-check.mjs [outDir]
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium, webkit } from 'playwright';
import { openDb } from '../hub/src/db.ts';
import { startHub } from '../hub/src/hub.ts';
import { queryHistory } from '../hub/src/history.ts';
import { seedHistory } from '../tools/seed-history.ts';
import { StationSimulator } from '../tools/station-sim.ts';

const out = resolve(process.argv[2] ?? 'ui-check');
mkdirSync(out, { recursive: true });
const PASSWORD = 'ui-check-password';
// WebKit runs as iPhone Safari in a tab: that is the first visit on the phone, and Playwright's
// WebKit build has no push service (its pushManager.getSubscription() blocks the page).
const IPHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';

const dataDir = mkdtempSync(join(tmpdir(), 'ui-check-'));
{
  const db = openDb(join(dataDir, 'hub.db'));
  seedHistory(db, { nowSec: Math.floor(Date.now() / 1000), days: 400 });
  db.close();
}

const hub = await startHub({
  dataDir,
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
{
  const nowSec = Math.floor(Date.now() / 1000);
  const t0 = performance.now();
  const year = queryHistory(hub.ctx.db, { from: nowSec - 365 * 86_400, to: nowSec, metrics: ['soc', 'in_w', 'out_w', 'ac_in_w', 'solar_w'], points: 400 });
  report.yearQueryMs = Math.round(performance.now() - t0);
  report.yearTable = year.table;
  if (year.table !== 'samples_1h' || report.yearQueryMs > 150) failed = true;
}

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
    userAgent: name === 'webkit' ? IPHONE_UA : undefined,
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
    const svgNaN = await page.evaluate(() => /NaN|undefined/.test(document.querySelector('.content')?.innerHTML ?? ''));
    if (svgNaN) issues.push(`${label}: NaN/undefined in markup`);
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
  // The status dot, not the text: the «Відключення» tab label is always on the page.
  await page.waitForSelector('.hero .status-line .dot[data-state="bad"]', { timeout: 15_000 });
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

  await page.click('a[href="#/charts"]');
  await page.waitForSelector('.chart-card[data-loading="false"] .chart-line', { state: 'attached', timeout: 15_000 });
  await page.waitForTimeout(500);
  await shot('charts-day');
  await checkText('charts-day');
  const powerSvg = page.locator('.chart-card').nth(1).locator('.chart-svg');
  const box = await powerSvg.boundingBox();
  if (box) await page.touchscreen.tap(box.x + box.width * 0.62, box.y + box.height * 0.5);
  await page.waitForSelector('.chart-card .chart-tip:not([hidden])', { timeout: 5_000 });
  await shot('charts-tooltip');
  await page.click('[data-preset="year"]');
  await page.waitForFunction(() => document.querySelector('.period-label')?.textContent === 'Останній рік');
  await page.waitForSelector('.chart-card[data-loading="false"] .chart-line', { state: 'attached', timeout: 15_000 });
  await page.waitForTimeout(500);
  await shot('charts-year');
  await checkText('charts-year');
  await bottom('charts-bottom');
  await page.locator('.chart-card').nth(2).locator('.chart-toggle').click();
  await page.waitForSelector('.chart-table table');
  await page.locator('.chart-card').nth(2).scrollIntoViewIfNeeded();
  await page.waitForTimeout(250);
  await page.screenshot({ path: join(out, `${name}-${String(++n).padStart(2, '0')}-charts-table.png`) });

  await page.click('a[href="#/outages"]');
  await page.waitForSelector('.cal-day');
  await page.waitForTimeout(400);
  await shot('outages');
  await checkText('outages');
  const darkDay = page.locator('.cal-day:not([data-level="0"]):not([disabled])').first();
  if (await darkDay.count()) {
    await darkDay.click();
    await page.waitForTimeout(250);
    await shot('outages-day');
  }
  await bottom('outages-bottom');

  await page.click('a[href="#/journal"]');
  await page.waitForSelector('.event-row');
  await page.waitForTimeout(300);
  await shot('journal');
  await checkText('journal');
  await page.click('[data-filter="grid"]');
  await page.waitForFunction(() => [...document.querySelectorAll('.event-row')].every((r) => r.getAttribute('data-type')?.startsWith('grid_')));
  await page.waitForTimeout(250);
  await shot('journal-grid');

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
