import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// jsdom doesn't load CSS (see graph.css.test.ts): this pins the rules.
const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'diff.css'), 'utf8');
const rule = (selector: string) => css.match(new RegExp(`(?:^|\\n)${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`))?.[1] ?? '';

describe('diff.css bars (K32-K34)', () => {
  it("the file name bar is --file-bar-bg and the File/Diff View bar the app background, not the action bar's", () => {
    expect(rule('.diff-header')).toMatch(/background:\s*var\(--file-bar-bg\)/);
    expect(rule('.diff-toolbar')).toMatch(/background:\s*var\(--app-bg0\)/);
  });
});

describe('diff.css motion (J19)', () => {
  it('the diff-toolbar segmented buttons (File/Diff View, Hunk/Inline/Split) fade colour fast and pressed background at the base token', () => {
    expect(rule('.diff-toolbar .segmented > button')).toMatch(/transition:\s*color var\(--motion-fast\), background-color var\(--motion-base\)/);
  });

  it('leaves the loading sweep alone: no idle animation gains a token, its reduced-motion override stays as-is', () => {
    expect(css).toMatch(/animation:\s*diff-progress 1\.1s ease-in-out infinite/);
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)[\s\S]*\.diff-progress::after \{ animation: none/);
  });

  it('never uses transition: all', () => {
    expect(css).not.toMatch(/transition:\s*all/);
  });
});
