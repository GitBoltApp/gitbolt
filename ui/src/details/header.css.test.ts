import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// jsdom doesn't load CSS (see graph.css.test.ts): this pins the rules.
const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'header.css'), 'utf8');
const rule = (selector: string) => css.match(new RegExp(`(?:^|\\n)${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`))?.[1] ?? '';

describe('header.css motion (J19)', () => {
  it('the Open-in-forge message button fades its hover background at the fast token', () => {
    expect(rule('.mr-button')).toMatch(/transition:\s*background-color var\(--motion-fast\)/);
  });
});
