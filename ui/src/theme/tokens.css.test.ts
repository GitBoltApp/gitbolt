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

describe('tokens.css panel bar (K5, K6)', () => {
  it('one shared bar box: the density\'s height, border included, and a 1 px divider in the border colour', () => {
    const bar = rule('.panel-bar');
    expect(bar).toMatch(/box-sizing:\s*border-box/);
    expect(bar).toMatch(/height:\s*var\(--panel-bar-h\)/);
    expect(bar).toMatch(/border-bottom:\s*1px solid var\(--section-border\)/);
  });
});
