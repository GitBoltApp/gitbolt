import { readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

// Windows and macOS file systems ignore case: with `Toast.tsx` beside `toast.ts`, an import of
// './Toast' found toast.ts there (`.ts` is tried before `.tsx`), and the component came out
// undefined. Two modules in one folder must differ by more than case.
function modules(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) modules(join(dir, e.name), out);
    else if (/\.(ts|tsx|js|mjs)$/.test(e.name)) out.push(join(dir, e.name).replace(/\.(test\.)?(ts|tsx|js|mjs)$/, ''));
  }
  return out;
}

describe('module names', () => {
  it('no two modules in a folder differ only by case', () => {
    const seen = new Map<string, string>();
    const clashes: string[] = [];
    for (const m of new Set(modules(__dirname))) {
      const other = seen.get(m.toLowerCase());
      if (other) clashes.push(`${relative(__dirname, other)} / ${relative(__dirname, m)}`);
      else seen.set(m.toLowerCase(), m);
    }
    expect(clashes).toEqual([]);
  });
});
