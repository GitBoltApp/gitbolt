import { describe, expect, it } from 'vitest';
import { countEdits, diffLines, compact, splitLines, unifiedHunks } from './lineDiff';

const L = (...xs: string[]) => xs.map((x) => `${x}\n`);
const numbered = (n: number, change: (i: number) => string | null | string[] = () => null) =>
  Array.from({ length: n }, (_, k) => k + 1).flatMap((i) => {
    const c = change(i);
    return c === null ? [`line ${i}\n`] : Array.isArray(c) ? c : [c];
  });

describe('line diff', () => {
  it('splits like git: each line keeps its newline, a last one without it stays separate', () => {
    expect(splitLines('a\nb\r\nc')).toEqual(['a\n', 'b\r\n', 'c']);
    expect(splitLines('')).toEqual([]);
    expect(splitLines('\n\n')).toEqual(['\n', '\n']);
  });

  it('finds no edit for equal sides, and one edit for a replaced line', () => {
    expect(diffLines(L('a', 'b'), L('a', 'b'))).toEqual([]);
    expect(diffLines(L('a', 'b', 'c'), L('a', 'B', 'c'))).toEqual([{ oldStart: 1, oldEnd: 2, newStart: 1, newEnd: 2 }]);
  });

  it('gives minimal counts, whatever repeats', () => {
    const a = L('x', 'a', 'b', 'x', 'a', 'b', 'x');
    const b = L('x', 'a', 'b', 'x', 'y', 'x', 'a', 'b', 'x');
    expect(countEdits(diffLines(a, b))).toEqual([2, 0]);
    expect(countEdits(diffLines(L('a', 'b', 'c'), L('c', 'b', 'a')))).toEqual([2, 2]);
    expect(countEdits(diffLines([], L('a', 'b')))).toEqual([2, 0]);
    expect(countEdits(diffLines(['x'], L('x')))).toEqual([1, 1]);
  });

  it('slides a run down past lines equal to its first one, merging runs it meets', () => {
    const lines = L('a', 'b', 'a', 'b', 'c', 'd');
    const changed = Uint8Array.from([1, 1, 0, 0, 0, 0]);
    compact(lines, changed);
    expect([...changed]).toEqual([0, 0, 1, 1, 0, 0]);
    const merge = L('a', 'a', 'a', 'b');
    const runs = Uint8Array.from([1, 0, 1, 0]);
    compact(merge, runs);
    expect([...runs]).toEqual([0, 1, 1, 0]);
  });

  it('slides a run up first, so it merges with a run above before sliding down', () => {
    const changed = Uint8Array.from([1, 0, 1]);
    compact(L('x', 'y', 'y'), changed);
    expect([...changed]).toEqual([1, 1, 0]);
  });

  it('moves a slid run back up to sit beside a change on the other side', () => {
    const lines = L('c', '}', '}', '}');
    const alone = Uint8Array.from([0, 1, 0, 0]);
    compact(lines, alone);
    expect([...alone]).toEqual([0, 0, 0, 1]);
    const paired = Uint8Array.from([0, 1, 0, 0]);
    compact(lines, paired, Uint8Array.from([0, 1, 1, 0, 0]));
    expect([...paired]).toEqual([0, 1, 0, 0]);
    // What `git diff` shows for this pair: the deletions and the addition in one group.
    expect(diffLines(L('c', 'c', 'b', '}', '}'), lines)).toEqual([{ oldStart: 1, oldEnd: 3, newStart: 1, newEnd: 2 }]);
  });

  // The placements below are what `git diff --no-index --no-indent-heuristic --diff-algorithm=myers` shows.
  it('joins the lowest change on the other side that a run can reach', () => {
    const a = L('x', 'k', 'k', 'k', 'k', 'k', 'k', 'y');
    const b = L('x', 'k', 'P', 'k', 'k', 'Q', 'k', 'k', 'y');
    expect(diffLines(a, b)).toEqual([
      { oldStart: 2, oldEnd: 2, newStart: 2, newEnd: 3 },
      { oldStart: 4, oldEnd: 5, newStart: 5, newEnd: 6 },
    ]);
  });

  it('aligns a run that merged with one above it', () => {
    expect(diffLines(L('c', 'b', 'b', 'c'), L('b', 'a', 'b', 'b'))).toEqual([
      { oldStart: 0, oldEnd: 1, newStart: 0, newEnd: 2 },
      { oldStart: 3, oldEnd: 4, newStart: 4, newEnd: 4 },
    ]);
  });

  it('compacts the old side first, then the new side against it', () => {
    expect(diffLines(L('a', 'x', 'x'), L('c', 'a', 'a', 'x'))).toEqual([
      { oldStart: 0, oldEnd: 0, newStart: 0, newEnd: 2 },
      { oldStart: 1, oldEnd: 2, newStart: 3, newEnd: 3 },
    ]);
  });

  it('takes the reach of a merged run afresh before aligning it', () => {
    // One minimal marking of `q w` against `w w y w q`: the new side's runs merge sliding down,
    // and the merged run can't go back up to where the first one started.
    const a = L('q', 'w');
    const b = L('w', 'w', 'y', 'w', 'q');
    const ca = Uint8Array.from([1, 0]);
    const cb = Uint8Array.from([1, 0, 1, 1, 1]);
    compact(a, ca, cb);
    compact(b, cb, ca);
    expect([...ca, ...cb]).toEqual([1, 0, 0, 1, 1, 1, 1]);
  });

  it('keeps hunks well formed among repeated lines', () => {
    const a = L('}', 'c', '}', 'b', 'a', 'b', '}', '', 'b', '}', '', '', 'b', '}');
    const b = L('}', 'c', '}', 'b', 'a', 'b', '}', '}', '', '', '}', '', 'b', '}', '}');
    const es = diffLines(a, b);
    expect(countEdits(es)).toEqual([3, 2]);
    for (const h of unifiedHunks(a, b, es, 1)) {
      const olds = h.lines.filter((l) => l.kind !== 'add');
      const news = h.lines.filter((l) => l.kind !== 'del');
      expect(olds.map((l) => l.old)).toEqual(Array.from({ length: h.oldLines }, (_, i) => h.oldStart + i));
      expect(news.map((l) => l.new)).toEqual(Array.from({ length: h.newLines }, (_, i) => h.newStart + i));
      expect(olds.map((l) => l.text)).toEqual(a.slice(h.oldStart - 1, h.oldStart - 1 + h.oldLines));
      expect(news.map((l) => l.text)).toEqual(b.slice(h.newStart - 1, h.newStart - 1 + h.newLines));
    }
  });

  it('places an inserted block bounded by blank lines lowest', () => {
    const a = L('fn a() {', '}', '', 'fn c() {', '}');
    const b = L('fn a() {', '}', '', 'fn b() {', '}', '', 'fn c() {', '}');
    expect(diffLines(a, b)).toEqual([{ oldStart: 3, oldEnd: 3, newStart: 3, newEnd: 6 }]);
  });

  it('sets aside lines only one side has, so a rewrite of unique lines stays fast and minimal', () => {
    const a = Array.from({ length: 30_000 }, (_, i) => (i % 2 === 0 ? `old ${i}\n` : 'same\n'));
    const b = Array.from({ length: 30_000 }, (_, i) => (i % 2 === 0 ? `new ${i}\n` : 'same\n'));
    expect(countEdits(diffLines(a, b))).toEqual([15_000, 15_000]);
  });

  it('gives up on a huge reordering of shared lines, counting every line changed', () => {
    const a = Array.from({ length: 3000 }, (_, i) => `line ${i}\n`);
    const b = [...a].reverse();
    expect(countEdits(diffLines(a, b))).toEqual([3000, 3000]);
  });

  it('builds -U3 hunks: merged within 6 lines, split beyond, clipped to the file', () => {
    const a = numbered(40);
    const near = numbered(40, (i) => (i === 10 || i === 16 ? `changed ${i}\n` : null));
    const far = numbered(40, (i) => (i === 10 || i === 18 ? `changed ${i}\n` : null));
    expect(unifiedHunks(a, near, diffLines(a, near)).map((h) => [h.oldStart, h.oldLines, h.newStart, h.newLines])).toEqual([[7, 13, 7, 13]]);
    expect(unifiedHunks(a, far, diffLines(a, far)).map((h) => [h.oldStart, h.oldLines, h.newStart, h.newLines])).toEqual([[7, 7, 7, 7], [15, 7, 15, 7]]);
    const top = numbered(10, (i) => (i === 1 ? 'first\n' : null));
    expect(unifiedHunks(numbered(10), top, diffLines(numbered(10), top))[0]).toMatchObject({ oldStart: 1, oldLines: 4, newStart: 1, newLines: 4 });
  });

  it('numbers each line on its side, deletions before additions', () => {
    const a = L('a', 'b', 'c');
    const b = L('a', 'B', 'b2', 'c');
    const [h] = unifiedHunks(a, b, diffLines(a, b));
    expect(h.lines.map((l) => [l.kind, l.old, l.new])).toEqual([['context', 1, 1], ['del', 2, 0], ['add', 0, 2], ['add', 0, 3], ['context', 3, 4]]);
  });

  it('writes a new file and a deleted file with a zero-count side', () => {
    const [created] = unifiedHunks([], L('one', 'two'), diffLines([], L('one', 'two')));
    expect([created.oldStart, created.oldLines, created.newStart, created.newLines]).toEqual([0, 0, 1, 2]);
    const [gone] = unifiedHunks(L('one'), [], diffLines(L('one'), []));
    expect([gone.oldStart, gone.oldLines, gone.newStart, gone.newLines]).toEqual([1, 1, 0, 0]);
  });

  it('flags the lines without a newline', () => {
    const a = ['a\n', 'b'];
    const b = ['a\n', 'b\n', 'c'];
    const [h] = unifiedHunks(a, b, diffLines(a, b));
    expect(h.lines.map((l) => [l.kind, l.text, l.noEol])).toEqual([['context', 'a\n', false], ['del', 'b', true], ['add', 'b\n', false], ['add', 'c', true]]);
    const same = ['a\n', 'z'];
    const edited = ['A\n', 'z'];
    const [k] = unifiedHunks(same, edited, diffLines(same, edited));
    expect(k.lines.at(-1)).toMatchObject({ kind: 'context', noEol: true });
  });

  it('flags the unterminated last line of a CRLF file, and an unchanged last line after a deletion', () => {
    const a = ['a\r\n', 'b'];
    const b = ['a\r\n', 'b\r\n'];
    const [h] = unifiedHunks(a, b, diffLines(a, b));
    expect(h.lines.map((l) => [l.kind, l.text, l.noEol])).toEqual([['context', 'a\r\n', false], ['del', 'b', true], ['add', 'b\r\n', false]]);
    const before = ['x\n', 'y\n', 'z'];
    const after = ['y\n', 'z'];
    const [k] = unifiedHunks(before, after, diffLines(before, after));
    expect(k.lines.map((l) => [l.kind, l.noEol])).toEqual([['del', false], ['context', false], ['context', true]]);
    const [created] = unifiedHunks([], ['only'], diffLines([], ['only']));
    expect(created).toMatchObject({ oldStart: 0, oldLines: 0, newStart: 1, newLines: 1, lines: [{ kind: 'add', noEol: true }] });
  });

  it('keeps counts minimal and hunks well formed on random pairs', () => {
    let seed = 0x5eed;
    const rand = () => {
      seed = (seed + 0x6d2b79f5) >>> 0;
      let t = Math.imul(seed ^ (seed >>> 15), seed | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32;
    };
    const below = (n: number) => Math.floor(rand() * n);
    const alphabet = ['a\n', 'b\n', '}\n', '\n', 'a\r\n', '  x();\n'];
    const side = (len: number) => {
      const xs = Array.from({ length: len }, () => alphabet[below(alphabet.length)]);
      if (xs.length && rand() < 0.2) xs[xs.length - 1] = xs[xs.length - 1].replace(/\r?\n$/, '');
      return xs;
    };
    for (let round = 0; round < 3000; round++) {
      const a = side(below(18));
      let b = side(below(18));
      if (rand() < 0.7) {
        b = a.slice();
        for (let k = 1 + below(3); k > 0; k--) b.splice(below(b.length + 1), below(3), ...side(below(4)));
      }
      const lcs = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
      for (let i = a.length - 1; i >= 0; i--)
        for (let j = b.length - 1; j >= 0; j--) lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
      const es = diffLines(a, b);
      expect(countEdits(es)).toEqual([b.length - lcs[0][0], a.length - lcs[0][0]]);
      // Edits are in order, apart, and the lines between them pair up with equal text.
      let i = 0;
      let j = 0;
      for (const e of es) {
        expect(e.oldStart - i).toBe(e.newStart - j);
        expect(e.oldStart > i || e.newStart > j || (i === 0 && j === 0)).toBe(true);
        for (; i < e.oldStart; i++, j++) expect(a[i]).toBe(b[j]);
        i = e.oldEnd;
        j = e.newEnd;
      }
      expect(a.slice(i)).toEqual(b.slice(j));
      // The hunks rebuild the new side from the old, without overlapping.
      const rebuilt: string[] = [];
      let at = 0;
      for (const h of unifiedHunks(a, b, es)) {
        const from = h.oldLines === 0 ? h.oldStart : h.oldStart - 1;
        expect(from).toBeGreaterThanOrEqual(at);
        rebuilt.push(...a.slice(at, from));
        at = from;
        for (const l of h.lines) {
          if (l.kind !== 'add') expect(a[at++]).toBe(l.text);
          if (l.kind !== 'del') rebuilt.push(l.text);
        }
        expect(at).toBe(from + h.oldLines);
      }
      rebuilt.push(...a.slice(at));
      expect(rebuilt).toEqual(b);
    }
  });

  it('keeps CRLF lines byte for byte', () => {
    const a = ['a\r\n', 'b\r\n'];
    const b = ['a\r\n', 'B\r\n'];
    const [h] = unifiedHunks(a, b, diffLines(a, b));
    expect(h.lines.filter((l) => l.kind !== 'context').map((l) => l.text)).toEqual(['b\r\n', 'B\r\n']);
    expect(countEdits(diffLines(['a\r\n'], ['a\n']))).toEqual([1, 1]);
  });
});
