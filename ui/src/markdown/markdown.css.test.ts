import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// jsdom doesn't load CSS (see image.css.test.ts): this pins the rules.
const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'markdown.css'), 'utf8');
const rule = (selector: string) => css.match(new RegExp(`(?:^|\\n)${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`))?.[1] ?? '';

describe('markdown.css (spec #5 §3.1)', () => {
  it('uses theme tokens only, and never transitions everything', () => {
    expect(css).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/i);
    expect(css).not.toMatch(/transition:\s*all/);
  });

  it('fits images to the width and keeps their aspect ratio (no shift when they load)', () => {
    expect(rule('.md-img')).toMatch(/max-width:\s*100%/);
    expect(rule('.md-img')).toMatch(/height:\s*auto/);
  });

  it('puts the Copy button over the block, out of the flow, shown on hover', () => {
    expect(rule('.md-copy')).toMatch(/position:\s*absolute/);
    expect(rule('.md-copy')).toMatch(/opacity:\s*0/);
    expect(rule('.md-code:hover .md-copy, .md-copy:focus-visible')).toMatch(/opacity:\s*1/);
  });

  it('keeps plain text as written, and lets the browser skip off-screen chunks', () => {
    expect(rule('.md-plain')).toMatch(/white-space:\s*pre-wrap/);
    expect(rule('.md-plain-chunk')).toMatch(/content-visibility:\s*auto/);
    expect(rule('.md-chunk')).toMatch(/content-visibility:\s*auto/);
  });

  it('hides the footnotes heading as GitHub does, and styles task lists by structure', () => {
    expect(rule('.md section[data-footnotes] > h2')).toMatch(/clip-path:\s*inset\(50%\)/);
    expect(rule('.md li:has(> input[type="checkbox"])')).toMatch(/list-style:\s*none/);
  });
});
