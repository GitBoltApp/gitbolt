import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';

const css = readFileSync(new URL('./site.css', import.meta.url), 'utf8');
const root = /:root\s*{([^}]*)}/.exec(css)?.[1] ?? '';
const token = (name: string) => new RegExp(`--${name}:\\s*(#[0-9a-f]{6})`, 'i').exec(root)?.[1] ?? '';

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
const contrast = (a: string, b: string) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};
/** --bg under the glass panels' 6 % white. */
const GLASS = '#161b2b';

test.each(['ink', 'muted', 'dim'])('--%s reads at 4.5:1 on the page and on glass', (name) => {
  expect(contrast(token(name), token('bg'))).toBeGreaterThanOrEqual(4.5);
  expect(contrast(token(name), GLASS)).toBeGreaterThanOrEqual(4.5);
});

test('--muted and --ink read at 4.5:1 on glass over glass-fill (a card holding a .fbtn)', () => {
  const over = '#242837'; // --bg under 6 % white twice
  for (const name of ['ink', 'muted']) expect(contrast(token(name), over), name).toBeGreaterThanOrEqual(4.5);
});

test("each lane's text colour reads at 4.5:1 on the page and on glass", () => {
  const lanes = [...css.matchAll(/\.l-([a-z]+)\s*{[^}]*--c-text:\s*(#[0-9a-f]{6})/g)];
  expect(lanes.map((m) => m[1])).toEqual(['teal', 'cyan', 'blue', 'violet', 'magenta', 'pink', 'orange', 'gold']);
  for (const [, lane, hex] of lanes) {
    expect(contrast(hex, token('bg')), lane).toBeGreaterThanOrEqual(4.5);
    expect(contrast(hex, GLASS), lane).toBeGreaterThanOrEqual(4.5);
  }
});

test('the live demo hides below a 992 px viewport, whatever its state', () => {
  const narrow = /@media \(max-width: 991\.98px\) {([\s\S]*?)\n}/.exec(css)?.[1] ?? '';
  expect(narrow).toContain('.hero-demo[data-state] .demo-live { visibility: hidden; }');
  expect(narrow).toContain('.hero-demo[data-state] .still { visibility: visible; }');
});

test('smooth scrolling and the demo\'s fade only without reduced motion', () => {
  expect(css).not.toMatch(/^html {[^}]*scroll-behavior/m);
  expect(css).toMatch(/@media \(prefers-reduced-motion: no-preference\) {[^}]*html { scroll-behavior: smooth; }/);
});
