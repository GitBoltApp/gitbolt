import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// jsdom doesn't load CSS (see graph.css.test.ts): this pins the rules.
const here = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(join(here, 'review.css'), 'utf8');
const files = readFileSync(join(here, '../../files/files.css'), 'utf8');
const ruleIn = (sheet: string, selector: string) => sheet.match(new RegExp(`(?:^|\\n)${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`))?.[1] ?? '';
const rule = (selector: string) => ruleIn(css, selector);
const background = (body: string) => /background:\s*([^;]+);/.exec(body)?.[1]?.trim();

describe("review.css: the file list's badge (spec 2026-10-08 §5)", () => {
  it("stays visible on a hovered or selected row: its resting background isn't the row's", () => {
    const badge = background(rule('.review-badge'));
    expect(badge).toBeTruthy();
    expect(badge).not.toBe(background(ruleIn(files, '.file-row:hover')));
    expect(badge).not.toBe(background(ruleIn(files, '.file-row[aria-selected="true"]')));
  });
});

describe('review.css: the chip in a narrow top bar (spec 2026-10-08 §4)', () => {
  it('shrinks, its value truncating with an ellipsis, while the Review options caret keeps its size', () => {
    expect(rule('.tb-review')).toMatch(/flex:\s*0 1 auto/);
    expect(rule('.tb-review')).toMatch(/min-width:\s*0/);
    expect(rule('.tb-review .tb-picker')).toMatch(/flex:\s*0 1 auto/);
    expect(rule('.tb-review .tb-caret, .tb-review .tb-value svg')).toMatch(/flex:\s*none/);
    const text = rule('.tb-review-text');
    expect(text).toMatch(/min-width:\s*0/);
    expect(text).toMatch(/overflow:\s*hidden/);
    expect(text).toMatch(/text-overflow:\s*ellipsis/);
  });
});
