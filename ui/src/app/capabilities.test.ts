import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

// Tauri refuses a window call its capability doesn't grant ("Command plugin:window|close not
// allowed by ACL"), and only at run time in the real app: jsdom and the harness never ask. So every
// `getCurrentWindow().<method>(` in the UI must have its `core:window:allow-<method>` granted,
// except the getters and event listeners `core:default` already allows.
const here = dirname(fileURLToPath(import.meta.url));
const src = join(here, '..');
const capability = JSON.parse(readFileSync(join(here, '../../../crates/gitbolt-app/capabilities/default.json'), 'utf8')) as { permissions: string[] };
const inDefault = (m: string) => /^(is|on|inner|outer|scale|title|theme|current)/.test(m);
const kebab = (m: string) => m.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) return sources(p);
    return /\.tsx?$/.test(n) && !/\.test\.tsx?$/.test(n) ? [p] : [];
  });
}

it("grants every window call the UI makes, so Quit isn't refused by the ACL", () => {
  const used = new Set<string>();
  for (const f of sources(src)) {
    for (const m of readFileSync(f, 'utf8').matchAll(/getCurrentWindow\(\)\s*\.\s*(\w+)\s*\(/g)) used.add(m[1]);
    // `win.destroy()` after `({ getCurrentWindow }) => { const win = getCurrentWindow(); …`
    if (/const win = getCurrentWindow\(\)/.test(readFileSync(f, 'utf8'))) {
      for (const m of readFileSync(f, 'utf8').matchAll(/\bwin\.(\w+)\s*\(/g)) used.add(m[1]);
    }
  }
  expect(used).toContain('close'); // Quit
  const missing = [...used].filter((m) => !inDefault(m) && !capability.permissions.includes(`core:window:allow-${kebab(m)}`));
  expect(missing).toEqual([]);
});
