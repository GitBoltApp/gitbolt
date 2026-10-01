import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// jsdom doesn't load CSS (see graph.css.test.ts): this pins the rules.
const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'tokens.css'), 'utf8');
const rule = (selector: string) => css.match(new RegExp(`(?:^|\\n)${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`))?.[1] ?? '';

describe('tokens.css motion (J19)', () => {
  it('defines the two chrome-tier motion tokens', () => {
    expect(css).toMatch(/--motion-fast:\s*50ms ease-in/);
    expect(css).toMatch(/--motion-base:\s*150ms ease-in/);
  });

  it('honours prefers-reduced-motion by zeroing every motion token, chrome and row alike, in one shared override', () => {
    const mediaBlocks = [...css.matchAll(/@media \(prefers-reduced-motion: reduce\)\s*\{([\s\S]*?)\n\}\n/g)];
    expect(mediaBlocks).toHaveLength(1);
    const media = mediaBlocks[0][1];
    expect(media).toMatch(/--motion-fast:\s*0s/);
    expect(media).toMatch(/--motion-base:\s*0s/);
    expect(media).toMatch(/--motion-row-color:\s*0s/);
    expect(media).toMatch(/--motion-row-dim:\s*0s/);
  });

  it('the motion block is kept separate from the other token blocks', () => {
    expect(css).toMatch(/\/\* ==== motion \(J19\)[\s\S]*==== end motion \(J19\) block ==== \*\//);
  });

  it('.icon-button fades its hover background/colour at the fast token, not layout props', () => {
    const button = rule('.icon-button');
    expect(button).toMatch(/transition:\s*background-color var\(--motion-fast\), color var\(--motion-fast\)/);
  });

  it('the scrollbar thumb fades its hover colour at the fast token', () => {
    expect(rule('::-webkit-scrollbar-thumb')).toMatch(/transition:\s*background-color var\(--motion-fast\)/);
  });

  it('never uses transition: all', () => {
    expect(css).not.toMatch(/transition:\s*all/);
  });
});

describe('tokens.css bar colours (K32-K34)', () => {
  const token = (name: string) => css.match(new RegExp(`${name}:\\s*(#[0-9a-f]{6})`, 'i'))?.[1].toLowerCase() ?? '';
  const lum = (hex: string) => {
    const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  };
  it("the three bar greys, brightest to darkest: action bar, file name bar, app background", () => {
    expect(token('--action-bar-bg')).toBe('#33373f');
    expect(token('--file-bar-bg')).toBe('#272a31');
    expect(token('--app-bg0')).toBe('#1c1e23');
    expect(lum(token('--action-bar-bg'))).toBeGreaterThan(lum(token('--file-bar-bg')));
    expect(lum(token('--file-bar-bg'))).toBeGreaterThan(lum(token('--app-bg0')));
    expect(token('--action-bar-bg')).not.toBe(token('--panel-bg0'));
  });
  it('text at the normal alpha (75% white, about #c6c6c9) keeps WCAG AA on the action bar', () => {
    expect((lum('#c6c6c9') + 0.05) / (lum(token('--action-bar-bg')) + 0.05)).toBeGreaterThan(4.5);
  });
});

describe('tokens.css panel bar (K5, K6)', () => {
  it('one shared bar box: the density\'s height, border included, and a 1 px divider in the border colour', () => {
    const bar = rule('.panel-bar');
    expect(bar).toMatch(/box-sizing:\s*border-box/);
    expect(bar).toMatch(/height:\s*var\(--panel-bar-h\)/);
    expect(bar).toMatch(/border-bottom:\s*1px solid var\(--section-border\)/);
  });
});
