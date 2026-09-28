import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// jsdom doesn't load CSS (see graph.css.test.ts): this pins the rules.
const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'tooltip.css'), 'utf8');
const rule = (selector: string) => css.match(new RegExp(`(?:^|\\n)${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`))?.[1] ?? '';

describe('tooltip.css motion (J19)', () => {
  it('fades opacity in at the base token, and only opacity', () => {
    const tooltip = rule('.hover-tooltip');
    expect(tooltip).toMatch(/transition:\s*opacity var\(--motion-base\)/);
    expect(tooltip).not.toMatch(/transition:\s*opacity var\(--motion-base\)[^;]*,/);
  });

  it('starts at opacity 0 so the fade-in has something to animate from, without delaying when it shows', () => {
    const starting = css.match(/@starting-style\s*\{\s*\.hover-tooltip\s*\{([^}]*)\}/)?.[1] ?? '';
    expect(starting).toMatch(/opacity:\s*0/);
  });
});
