import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

// vitest doesn't load CSS (see graph.css.test.ts): pin the source.
const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'repo.css'), 'utf8');

it('no per-area focus visuals: nothing is styled by the focus zone (feedback H4 overrides spec §11.1)', () => {
  const selectors = [...css.matchAll(/([^{}]*)\{[^}]*\}/g)].map(([, sel]) => sel);
  for (const sel of selectors) expect(sel).not.toMatch(/data-zone-focused|data-focus-zone/);
});
