import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// jsdom doesn't load CSS (see graph.css.test.ts): this pins the rules.
const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'menu.css'), 'utf8');
const rule = (selector: string) => css.match(new RegExp(`(?:^|\\n)${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`))?.[1] ?? '';

describe('menu.css motion (J19 remainder)', () => {
  it('a row fades its hover/active background at the fast token (50ms ease-in)', () => {
    expect(rule('.ctx-row')).toMatch(/transition:\s*background-color var\(--motion-fast\)/);
  });

  it('transitions colour/background only, never layout', () => {
    for (const t of css.match(/transition:[^;}]*/g) ?? []) expect(t).toMatch(/^transition:\s*background-color /);
  });
});

describe('inline variants are a gapless button group (K25)', () => {
  it('the group has no gap between its buttons', () => {
    expect(rule('.ctx-variants')).not.toMatch(/\bgap\s*:/);
  });

  it('adjacent variant buttons share a 1px divider instead of a gap', () => {
    expect(css).toMatch(/\.ctx-variant \+ \.ctx-variant\s*\{[^}]*border-left:\s*1px/);
  });
});
