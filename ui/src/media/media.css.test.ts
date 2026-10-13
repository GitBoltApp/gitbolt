import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// jsdom doesn't load CSS (see graph.css.test.ts): this pins the rules.
const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'media.css'), 'utf8');
const rule = (selector: string) => css.match(new RegExp(`(?:^|\\n)${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`))?.[1] ?? '';

describe('media.css font preview', () => {
  it('the family/style line keeps its height when the glyph grid is taller than the pane, which scrolls', () => {
    expect(rule('.font-name')).toMatch(/flex-shrink:\s*0/);
    expect(rule('.media-pane')).toMatch(/overflow:\s*auto/);
  });
});
