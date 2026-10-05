import type { UiDeps } from '../deps.ts';
import type { Page } from '../router.ts';
import { h } from '../ui/dom.ts';

export function createSettingsPage(_deps: UiDeps): Page {
  return { el: h('div', { text: 'Налаштування' }) };
}
