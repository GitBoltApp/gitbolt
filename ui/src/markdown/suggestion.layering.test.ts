import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// The Markdown chunk loads lazily: a suggestion's Apply comes in through `MdSuggestionApply` from
// the forge code, so the code blocks never pull the forge's write path (or the Undo feature) in.
const here = dirname(fileURLToPath(import.meta.url));
const imports = (file: string) => [...readFileSync(join(here, file), 'utf8').matchAll(/^import [^;]*? from '([^']+)';/gms)].map((m) => m[1]!);

describe("a suggestion's Apply stays out of the Markdown code", () => {
  it.each(['MdCode.tsx', 'suggestion.ts'])('%s imports no forge, write, undo or working-copy code', (file) => {
    const found = imports(file);
    expect(found.length).toBeGreaterThan(0);
    expect(found.filter((p) => /\/(forge|write|undo)\/|workingCopy/.test(p))).toEqual([]);
  });
});
