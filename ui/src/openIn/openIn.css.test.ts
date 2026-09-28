import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// jsdom doesn't load CSS (see graph.css.test.ts): this pins the rules.
const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'openIn.css'), 'utf8');
const rule = (selector: string) => css.match(new RegExp(`(?:^|\\n)${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`))?.[1] ?? '';

describe('openIn.css motion (J19)', () => {
  it('the split button (main + caret) fades hover background/colour at the fast token', () => {
    expect(rule('.open-in-main, .open-in-toggle')).toMatch(/transition:\s*background-color var\(--motion-fast\), color var\(--motion-fast\)/);
  });

  it('the menu items fade hover background/colour at the fast token', () => {
    expect(rule('.open-in-item')).toMatch(/transition:\s*background-color var\(--motion-fast\), color var\(--motion-fast\)/);
  });

  it('never uses transition: all', () => {
    expect(css).not.toMatch(/transition:\s*all/);
  });
});
