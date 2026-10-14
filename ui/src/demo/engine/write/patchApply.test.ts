import { describe, expect, it } from 'vitest';
import { diffLines, splitLines, unifiedHunks } from '../read/lineDiff';
import { applySelection, selectionLabel } from './patchApply';

const hunks = (a: string, b: string) => unifiedHunks(splitLines(a), splitLines(b), diffLines(splitLines(a), splitLines(b)), 3);
const thirty = (changed: number[]) => Array.from({ length: 30 }, (_, k) => k + 1).map((i) => (changed.includes(i) ? `L${i} changed\n` : `L${i}\n`)).join('');

describe('a selection applied to one side', () => {
  it('stages one hunk forward and leaves the other', () => {
    const [a, b] = [thirty([]), thirty([3, 20])];
    const h = hunks(a, b);
    const r = applySelection(splitLines(a), h, { kind: 'hunks', hunks: [1] }, 'forward')!;
    expect(r.lines.join('')).toBe(thirty([20]));
    expect([r.picked, r.allPicked]).toEqual([2, false]);
    expect(selectionLabel(h, { kind: 'hunks', hunks: [1] }, 'forward')).toBe('a hunk');
  });

  it('unstages (reverse) the picked lines only', () => {
    const [a, b] = [thirty([]), thirty([3, 20])];
    const h = hunks(a, b);
    const sel = { kind: 'lines' as const, old: [{ start: 3, end: 3 }], new: [{ start: 3, end: 3 }] };
    expect(applySelection(splitLines(b), h, sel, 'reverse')!.lines.join('')).toBe(thirty([20]));
    expect(selectionLabel(h, sel, 'reverse')).toBe('2 lines');
    expect(applySelection(splitLines(b), h, { kind: 'hunks', hunks: [] }, 'reverse')).toBeNull();
  });

  it('a line appended after a no-newline end stages with that line (Review Focus 4)', () => {
    const [a, b] = ['a\nb', 'a\nb\nc\n'];
    const h = hunks(a, b);
    // git shows `-b⏎̸ +b +c`; staging only `+c` (new line 3) takes the pair, keeping `b`.
    const r = applySelection(splitLines(a), h, { kind: 'lines', old: [], new: [{ start: 3, end: 3 }] }, 'forward')!;
    expect(r.lines.join('')).toBe('a\nb\nc\n');
  });

  it('keeps CRLF bytes and a final line without a newline', () => {
    const [a, b] = ['x\r\ny\r\nz', 'x\r\nY\r\nz'];
    const r = applySelection(splitLines(a), hunks(a, b), { kind: 'hunks', hunks: [0] }, 'forward')!;
    expect([r.lines.join(''), r.allPicked]).toEqual(['x\r\nY\r\nz', true]);
  });

  it('a picked line alone of a pair stages without the other, either way', () => {
    const [a, b] = [thirty([]), thirty([3])];
    const h = hunks(a, b);
    // Only `-L3`: the old line goes, `L3 changed` never comes.
    expect(applySelection(splitLines(a), h, { kind: 'lines', old: [{ start: 3, end: 3 }], new: [] }, 'forward')!.lines.join('')).toBe(thirty([]).replace('L3\n', ''));
    // Reverse, only `+L3 changed` picked: it goes, the unpicked `-L3` stays out.
    expect(applySelection(splitLines(b), h, { kind: 'lines', old: [], new: [{ start: 3, end: 3 }] }, 'reverse')!.lines.join('')).toBe(thirty([]).replace('L3\n', ''));
  });
});
