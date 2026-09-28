import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// jsdom doesn't load CSS (see graph.css.test.ts): this pins the rules.
const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'image.css'), 'utf8');
const rule = (selector: string) => css.match(new RegExp(`(?:^|\\n)${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`))?.[1] ?? '';

describe('image.css motion (J19)', () => {
  it('the image toolbar segmented/toggle buttons fade colour fast and pressed background at the base token', () => {
    expect(rule('.image-toolbar .segmented > button, .image-toolbar .toggle')).toMatch(/transition:\s*color var\(--motion-fast\), background-color var\(--motion-base\)/);
  });

  it('never transitions the image frame/layer (transform-origin, box-shadow bounds — no layout/canvas motion)', () => {
    expect(rule('.image-frame')).not.toMatch(/transition/);
    expect(rule('.image-layer')).not.toMatch(/transition/);
  });

  it('never uses transition: all', () => {
    expect(css).not.toMatch(/transition:\s*all/);
  });
});
