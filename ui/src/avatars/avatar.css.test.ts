import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

// jsdom doesn't load CSS: this pins the rule.
const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'avatar.css'), 'utf8');

it("a loaded picture sits on the avatar backdrop, as the graph's does", () => {
  expect(css).toMatch(/\.avatar img:not\(\[data-loading\]\)\s*\{[^}]*background:\s*var\(--avatar-backdrop\)/);
});
