// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHubInfo } from './components/hub-info.ts';
import type { UiDeps } from './deps.ts';
import { createAppStore } from './store.ts';
import type { HubInfo } from './types.ts';

afterEach(() => document.body.replaceChildren());
const flush = () => new Promise((r) => setTimeout(r, 0));
const NOW = Math.floor(new Date(2026, 9, 6, 18).getTime() / 1000);
const INFO: HubInfo = {
  version: 'v0.4.0',
  dbBytes: 420_000_000,
  budgetBytes: 10_000_000_000,
  backup: { dir: '/sdcard/fossibot-backups', last: { file: 'fossibot-2026-10-06.db', ts: Math.floor(new Date(2026, 9, 6, 4, 0).getTime() / 1000) } },
};

async function mount(info: HubInfo = INFO) {
  const api = { hubInfo: vi.fn(async () => info) };
  const deps = { store: createAppStore(), api, run: vi.fn(), confirm: vi.fn(), notify: vi.fn(), onLoggedOut: vi.fn() } as unknown as UiDeps;
  const c = createHubInfo(deps, { now: () => NOW });
  document.body.append(c.el);
  await flush();
  return c.el;
}
const row = (el: HTMLElement, name: string) => el.querySelector(`[data-row="${name}"] span:last-child`)?.textContent;

describe('hub info', () => {
  it('shows memory, the last backup and the version', async () => {
    const el = await mount();
    expect(row(el, 'memory')).toBe('0.42 ГБ з 10 ГБ');
    expect(row(el, 'backup')).toBe('Сьогодні, 04:00');
    expect(row(el, 'version')).toBe('v0.4.0');
  });

  it('says when there has been no backup yet or backups are off', async () => {
    expect(row(await mount({ ...INFO, backup: { dir: '/x', last: null } }), 'backup')).toBe('ще не було');
    document.body.replaceChildren();
    expect(row(await mount({ ...INFO, backup: { dir: null, last: null } }), 'backup')).toBe('вимкнено');
  });

  it('builds the CSV link from the chosen data and period; 10-second samples stop at 30 days', async () => {
    const el = await mount();
    const link = el.querySelector('a[data-action="export"]') as HTMLAnchorElement;
    const kind = el.querySelector('select[aria-label="Що експортувати"]') as HTMLSelectElement;
    const period = el.querySelector('select[aria-label="За який час"]') as HTMLSelectElement;
    expect(link.getAttribute('href')).toBe(`/api/export.csv?kind=energy&from=${NOW - 30 * 86_400}&to=${NOW}`);
    period.value = '365';
    period.dispatchEvent(new Event('change'));
    expect(link.getAttribute('href')).toBe(`/api/export.csv?kind=energy&from=${NOW - 365 * 86_400}&to=${NOW}`);
    kind.value = 'samples';
    kind.dispatchEvent(new Event('change'));
    expect(period.value).toBe('30');
    expect(period.disabled).toBe(true);
    expect(link.getAttribute('href')).toBe(`/api/export.csv?kind=samples&from=${NOW - 30 * 86_400}&to=${NOW}`);
    expect(link.hasAttribute('download')).toBe(true);
  });
});
