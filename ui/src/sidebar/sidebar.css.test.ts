import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

// vitest doesn't load CSS (see graph.css.test.ts): pin the source.
const dir = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(join(dir, 'sidebar.css'), 'utf8');
const tokens = readFileSync(join(dir, '..', 'theme', 'tokens.css'), 'utf8');

it('the checked-out row is green (a token), not the blue selection colour; the cursor outline stays blue', () => {
  expect(tokens).toMatch(/--checked-out-row:\s*#37563e/);
  expect(tokens).toMatch(/--checked-out:\s*#457c4a/);
  const rule = css.match(/\.sb-item\.is-head\s*\{([^}]*)\}/)?.[1] ?? '';
  expect(rule).toMatch(/background:\s*var\(--checked-out-row\)/);
  expect(rule).not.toMatch(/--selected-row/);
  expect(css).toMatch(/\.co-check\s*\{[^}]*background:\s*var\(--checked-out\)/);
  expect(css).toMatch(/\.sb-list:focus \.sb-row\[data-active="true"\]\s*\{\s*outline:\s*1px solid var\(--blue\)/);
});

it('K55: counts are bold light blue (a token); K56: the stack never scrolls itself', () => {
  expect(tokens).toMatch(/--count-blue:\s*#6d9deb/);
  expect(css).toMatch(/\.sb-count\s*\{[^}]*font-weight:\s*700;[^}]*var\(--count-blue\)/);
  expect(css).toMatch(/\.sn-count\s*\{[^}]*font-weight:\s*700;[^}]*var\(--count-blue\)/);
  expect(css).toMatch(/\.sb-stack\s*\{[^}]*overflow:\s*hidden/);
});

it('K62: row and strip icons use the dimmer --sidebar-icon, brightening on hover or the cursor; brand marks, the check and an MR/PR state icon keep theirs', () => {
  expect(tokens).toMatch(/--sidebar-icon:\s*rgba\(255, 255, 255, 0\.45\)/);
  expect(css).toMatch(/\.sb-row > svg:not\(\[data-host-kind\], \.mr-state-icon\)\s*\{[^}]*var\(--sidebar-icon\)/);
  expect(css).toMatch(/\.sb-row:hover > svg:not\(\[data-host-kind\], \.mr-state-icon\)[^{]*\{[^}]*var\(--text-normal\)/);
  expect(css).toMatch(/\.sn-item svg\s*\{[^}]*var\(--sidebar-icon\)/);
});
