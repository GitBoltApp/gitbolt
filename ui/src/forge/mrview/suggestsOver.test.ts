import { describe, expect, it } from 'vitest';
import type { DiffPosition } from '../../api/gen/DiffPosition';
import { suggestsOver } from './Thread';

const pos = (snippet: string | null, line = 7, startLine: number | null = 5): DiffPosition => ({ path: 'cart.ts', oldPath: null, line, oldLine: null, snippet, startLine, startOldLine: null });

describe('suggestsOver (the snippet is left out under a suggestion that shows it)', () => {
  const snippet = '+  console.log(sum);\n }\n-return sum;\n+return sum - discount;';
  it('a suggestion whose replaced lines the snippet holds: the snippet goes', () => {
    expect(suggestsOver('github', 'Tidier:\n\n```suggestion\nreturn Math.max(0, sum);\n```', pos(snippet))).toBe(true);
    expect(suggestsOver('gitlab', '```suggestion:-2+0\nreturn 0;\n```', pos(snippet))).toBe(true);
  });
  it('no suggestion, no snippet, or one reaching past the snippet: the snippet stays', () => {
    expect(suggestsOver('github', 'Why this line?', pos(snippet))).toBe(false);
    expect(suggestsOver('gitlab', '```suggestion:-9+0\nreturn 0;\n```', pos(snippet))).toBe(false);
    expect(suggestsOver('github', '```suggestion\nx\n```', pos(null))).toBe(false);
  });
});
