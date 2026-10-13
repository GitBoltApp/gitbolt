import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';

const read = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8');
const firstPaint = (html: string) => /<script id="theme-first-paint">[\s\S]*?<\/script>/.exec(html)?.[0];

test("demo.html is index.html's page with the demo's entry", () => {
  const index = read('../../index.html');
  const demo = read('../../demo.html');
  expect(firstPaint(demo)).toBeDefined();
  expect(firstPaint(demo)).toBe(firstPaint(index));
  expect(demo).toContain('<script type="module" src="/src/demo/main.tsx"></script>');
  expect(demo).toContain('<div id="root"></div>');
});
