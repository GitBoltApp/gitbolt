import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { GROUP_COLORS } from '../app/tabGroups';
import { contrastRatio } from '../theme/contrast';
import { THEME_IDS, THEMES } from '../theme/themes';

// jsdom doesn't load CSS (see graph.css.test.ts): this pins the rules.
const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'tabs.css'), 'utf8');
const rule = (selector: string) => css.match(new RegExp(`(?:^|\\n)${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`))?.[1] ?? '';

describe('tabs.css: tab groups', () => {
  it('a group\'s top border is one element on top of the strip, above the tabs\' separators, in the group\'s colour (no layout)', () => {
    const line = rule('.tg-line');
    expect(line).toMatch(/position:\s*absolute;\s*top:\s*0/);
    expect(line).toMatch(/height:\s*2px;\s*background:\s*var\(--group-color\)/);
    // Under a lifted (dragged) tab, z-index 2; its own group's line over it, and a dragged group's.
    expect(line).toMatch(/pointer-events:\s*none;\s*z-index:\s*1/);
    expect(rule('.tg-line.lifted, .tg-over')).toMatch(/z-index:\s*3/);
    expect(rule('.tabs.reordering .tab.lifted')).toMatch(/z-index:\s*2/);
    expect(rule('.tabs')).toMatch(/position:\s*relative/);
    // No per-tab or per-chip pieces any more.
    expect(css).not.toMatch(/::before/);
  });

  it('the chip: a circle without a name, a pill with one, its top-left corner square', () => {
    const pill = rule('.tg-chip-pill');
    expect(pill).toMatch(/min-width:\s*22px;\s*height:\s*22px/);
    expect(pill).toMatch(/border-radius:\s*0 11px 11px 11px/);
    expect(rule('.tg-chip-pill:empty')).toMatch(/width:\s*22px;\s*padding:\s*0/);
  });

  it('a drop onto a tab previews the group\'s top border only: no outline', () => {
    expect(css).not.toMatch(/\.drop-onto\s*\{/);
  });

  it('collapsing and expanding: a collapsed group\'s tabs shrink to no width and grow back, at the strip\'s slide (none with reduced motion)', () => {
    expect(rule('.tab.tab-hidden')).toMatch(/width:\s*0;\s*min-width:\s*0;\s*padding-left:\s*0;\s*padding-right:\s*0;\s*border-right-width:\s*0;\s*opacity:\s*0/);
    expect(rule('.tab')).toMatch(/width var\(--tab-slide\), min-width var\(--tab-slide\), padding var\(--tab-slide\)/);
    expect(rule('.tabs')).toMatch(/interpolate-size:\s*allow-keywords;\s*--tab-slide:\s*150ms ease-out/);
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\) \{ \.tabs \{ --tab-slide: 0s; \} \}/);
  });

  it('each palette colour is a theme token, readable on every theme', () => {
    for (const c of GROUP_COLORS) {
      expect(rule(`[data-group-color="${c}"]`)).toMatch(new RegExp(`--group-color:\\s*var\\(--tg-${c}\\)`));
      for (const id of THEME_IDS) {
        const colors = THEMES[id].colors;
        // The chip's ink on the colour, and the colour (the top border) on the tab bar: at least 3:1.
        expect(contrastRatio(colors['tg-ink'], colors[`tg-${c}`]), `${id} ${c} ink`).toBeGreaterThanOrEqual(3);
        expect(contrastRatio(colors[`tg-${c}`], colors['tab-bar-bg']), `${id} ${c} on the bar`).toBeGreaterThanOrEqual(3);
      }
    }
  });
});

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
