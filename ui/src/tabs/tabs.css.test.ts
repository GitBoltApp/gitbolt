import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// jsdom doesn't load CSS (see graph.css.test.ts): this pins the rules.
const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'tabs.css'), 'utf8');
const rule = (selector: string) => css.match(new RegExp(`(?:^|\\n)${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`))?.[1] ?? '';

describe('tabs.css (K64)', () => {
  it('the selected tab shares the action bar\'s background, so it reads as the tab of the bar below', () => {
    expect(rule('.tab[aria-selected="true"]')).toMatch(/background:\s*var\(--action-bar-bg\)/);
  });

  it('K71: no border on the selected tab or on its left neighbour, only between unselected tabs', () => {
    expect(rule('.tab[aria-selected="true"], .tab:has(+ .tab[aria-selected="true"])')).toMatch(/border-right-color:\s*transparent/);
    expect(rule('.tab')).toMatch(/border-right:\s*1px solid var\(--section-border\)/);
  });

  it('K65: the bar is the darker --tab-bar-bg, and its bottom edge is a background line the selected tab covers (no border)', () => {
    const bar = rule('.tab-bar');
    expect(bar).toMatch(/var\(--tab-bar-bg\)/);
    expect(bar).toMatch(/linear-gradient\(to top, var\(--section-border\) 1px, transparent 1px\)/);
    expect(bar).not.toMatch(/border-bottom/);
    // A hovered (unselected) tab keeps the line.
    expect(rule('.tab:not([aria-selected="true"]):hover')).toMatch(/box-shadow:\s*inset 0 -1px var\(--section-border\)/);
  });
});
