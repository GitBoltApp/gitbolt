import { describe, expect, it } from 'vitest';
import { diffLines, splitLines, unifiedHunks } from './lineDiff';
import { selectedLines } from './patchSelect';
import { thirty } from './testkit';

const hunks = (a: string, b: string) => {
  const al = splitLines(a);
  const bl = splitLines(b);
  return unifiedHunks(al, bl, diffLines(al, bl));
};
const lines = (old: [number, number][], neu: [number, number][]) => ({ kind: 'lines' as const, old: old.map(([start, end]) => ({ start, end })), new: neu.map(([start, end]) => ({ start, end })) });

describe('selection counts', () => {
  it('counts the changed lines a selection takes, in both directions', () => {
    const h = hunks(thirty([]), thirty([3, 20]));
    expect(selectedLines(h, lines([[2, 22]], [[1, 4]]), 'forward')).toEqual({ hunks: 2, lines: 3 });
    expect(selectedLines(h, lines([[2, 22]], [[1, 4]]), 'reverse').lines).toBe(3);
    expect(selectedLines(h, lines([], [[10, 12]]), 'forward')).toEqual({ hunks: 0, lines: 0 });
    expect(selectedLines(h, { kind: 'hunks', hunks: [1] }, 'forward')).toEqual({ hunks: 1, lines: 2 });
  });

  it('the tie takes the re-added line when a line without a newline is staged before another', () => {
    const h = hunks('a\nb', 'a\nb\nc\n');
    // Staging "+c" alone would leave "b" (no newline) followed by "c": the tie takes "-b" and "+b" too.
    expect(selectedLines(h, lines([], [[3, 3]]), 'forward')).toEqual({ hunks: 1, lines: 3 });
    // Staging "-b" and "+b" with a newline, but not "+c": nothing after b on its side, so no tie.
    expect(selectedLines(h, lines([[2, 2]], [[2, 2]]), 'forward')).toEqual({ hunks: 1, lines: 2 });
  });

  it('the tie in reverse takes the additions after a picked line without a newline', () => {
    const h = hunks('a\nb', 'a\nc');
    expect(selectedLines(h, lines([[2, 2]], []), 'reverse')).toEqual({ hunks: 1, lines: 2 });
  });
});
