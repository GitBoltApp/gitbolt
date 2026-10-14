import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';

const read = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8');

test("the icon and the favicon are the app's (concept 2), byte for byte", () => {
  expect(read('./art/icon.svg')).toBe(read('../../crates/gitvolt-app/icons/source.svg'));
  expect(read('./art/favicon.svg')).toBe(read('../../crates/gitvolt-app/icons/source-small.svg'));
});

test.each(['hero-lanes', 'bands', 'divider-1', 'divider-2', 'divider-3', 'divider-4'])('%s.svg is a standalone drawing with nothing the CSP or an <img> would drop', (name) => {
  const svg = read(`./art/${name}.svg`);
  expect(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg" ')).toBe(true);
  expect(svg).toMatch(/viewBox="0 0 [\d.]+ [\d.]+"/);
  expect(svg).not.toMatch(/style=|<script|href=|url\(http/);
  expect(svg.match(/<svg\b/g)).toHaveLength(1);
});
