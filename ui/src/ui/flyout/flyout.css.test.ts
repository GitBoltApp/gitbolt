import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

// jsdom doesn't load CSS: this pins the rules.
const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'flyout.css'), 'utf8');
const rule = (selector: string) => css.match(new RegExp(`(?:^|\\n)${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`))?.[1] ?? '';

it('a wrapping flyout title wraps instead of ending in an ellipsis', () => {
  expect(rule('.flyout-title')).toMatch(/text-overflow:\s*ellipsis/);
  expect(rule('.flyout-head.wrap .flyout-title')).toMatch(/white-space:\s*normal/);
  expect(rule('.flyout-head.wrap .flyout-title')).toMatch(/overflow:\s*visible/);
});
