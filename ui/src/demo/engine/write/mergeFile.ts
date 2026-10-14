/**
 * A three-way merge of lines as git's content merge behaves, written clean-room from the output of
 * `git merge-file` and `git merge` (never from git's source, which is LGPL/GPL):
 * 1. each side's edits against the base, in base order; edits that overlap or touch form a group; a
 *    group with one side's edits takes it, one where both sides make the same lines is clean, any
 *    other conflicts;
 * 2. `merge` style refines a conflict by a diff of its sides (lines both have split it), then joins a
 *    conflict with the next when only shared lines (unchanged, or changed the same way by both)
 *    lie between: at most 3, or none with an ASCII letter or digit;
 * 3. `diff3` style does neither and shows the base;
 * 4. a last line without a newline gets one before a marker; a conflict's markers (and those
 *    newlines) are CRLF when the base's first line ends in CRLF and neither ours' nor theirs' line
 *    before the conflict (a side's first line where the conflict starts it) ends in a bare LF: an
 *    empty side, or a line without a newline, doesn't decide.
 * Where it can differ: git's merge diffs with the histogram algorithm (`merge-file` with Myers), and
 * 1b's `diffLines` lacks git's indent heuristic and may keep other copies of repeated lines, so a
 * conflict's extent can differ where edits sit among repeated lines.
 */
import { diffLines, splitLines } from '../read/lineDiff';
import { sideText, type SideEdit } from '../read/merge3';

export type MergeStyle = 'merge' | 'diff3';
/** Lines keep their terminators (1b's `splitLines`). A `merge`-style conflict's `base` is empty (git
 *  shows none); `crlf`: its markers end in CRLF. */
export type Chunk = { kind: 'common'; lines: string[] } | { kind: 'conflict'; base: string[]; ours: string[]; theirs: string[]; crlf: boolean };
export interface MergeLabels {
  ours: string;
  base: string;
  theirs: string;
}

type Piece = Chunk | { kind: 'taken'; lines: string[] };
type Conflict = Extract<Chunk, { kind: 'conflict' }>;

const same = (a: string[], b: string[]) => a.length === b.length && a.every((l, i) => l === b[i]);

/** The line before `at` in `lines`; the first line at the start; null in an empty file. */
const lineBefore = (lines: string[], at: number): string | null => lines[Math.max(at - 1, 0)] ?? null;
/** A side's part of the markers' rule: its line before the conflict doesn't end in a bare LF. */
const sideCrlf = (lines: string[], at: number) => {
  const l = lineBefore(lines, at);
  return l === null || !l.endsWith('\n') || l.endsWith('\r\n');
};

/** A conflict's two sides (at `o` in ours, `t` in theirs), split where they share lines (`merge`
 *  style); `baseCrlf`: the base's part of the markers' rule. */
function refine(a: string[], b: string[], ours: string[], theirs: string[], o: number, t: number, baseCrlf: boolean): Piece[] {
  const out: Piece[] = [];
  let x = 0;
  for (const e of diffLines(a, b)) {
    if (e.oldStart > x) out.push({ kind: 'common', lines: a.slice(x, e.oldStart) });
    const crlf = baseCrlf && sideCrlf(ours, o + e.oldStart) && sideCrlf(theirs, t + e.newStart);
    out.push({ kind: 'conflict', base: [], ours: a.slice(e.oldStart, e.oldEnd), theirs: b.slice(e.newStart, e.newEnd), crlf });
    x = e.oldEnd;
  }
  if (x < a.length) out.push({ kind: 'common', lines: a.slice(x) });
  return out;
}

/** Adjacent common pieces as one. */
function mergeCommons(pieces: Piece[]): Piece[] {
  const out: Piece[] = [];
  for (const p of pieces) {
    const last = out[out.length - 1];
    if (p.kind === 'common' && last?.kind === 'common') out[out.length - 1] = { kind: 'common', lines: [...last.lines, ...p.lines] };
    else out.push(p);
  }
  return out;
}

const joinable = (gap: string[]) => gap.length <= 3 || !gap.some((l) => /[A-Za-z0-9]/.test(l));

/** `merge` style: a conflict, shared lines, a conflict → one conflict when the gap is joinable. */
function join(pieces: Piece[]): Piece[] {
  const out: Piece[] = [];
  for (const p of mergeCommons(pieces)) {
    const n = out.length;
    const gap = out[n - 1];
    const prev = out[n - 2];
    if (p.kind === 'conflict' && gap?.kind === 'common' && prev?.kind === 'conflict' && joinable(gap.lines)) {
      out.splice(n - 2, 2, { kind: 'conflict', base: [], ours: [...prev.ours, ...gap.lines, ...p.ours], theirs: [...prev.theirs, ...gap.lines, ...p.theirs], crlf: prev.crlf });
    } else out.push(p);
  }
  return out;
}

export function mergeLines(base: string[], ours: string[], theirs: string[], style: MergeStyle): Chunk[] {
  const edits: SideEdit[] = [...diffLines(base, ours).map((e) => ({ ...e, ours: true })), ...diffLines(base, theirs).map((e) => ({ ...e, ours: false }))].sort((x, y) => x.oldStart - y.oldStart);
  const pieces: Piece[] = [];
  const baseCrlf = lineBefore(base, 0)?.endsWith('\r\n') ?? false;
  // Where the next line is in the base, ours and theirs.
  let [at, o, t] = [0, 0, 0];
  let i = 0;
  while (i < edits.length) {
    const from = edits[i].oldStart;
    let to = edits[i].oldEnd;
    let j = i + 1;
    while (j < edits.length && edits[j].oldStart <= to) to = Math.max(to, edits[j++].oldEnd);
    const group = edits.slice(i, j);
    i = j;
    if (from > at) pieces.push({ kind: 'common', lines: base.slice(at, from) });
    [o, t] = [o + from - at, t + from - at];
    at = to;
    const mine = group.filter((e) => e.ours);
    const yours = group.filter((e) => !e.ours);
    const a = sideText(base, ours, mine, from, to);
    const b = sideText(base, theirs, yours, from, to);
    if (mine.length === 0) pieces.push({ kind: 'taken', lines: b });
    else if (yours.length === 0) pieces.push({ kind: 'taken', lines: a });
    // Both sides made the same lines: shared lines, which a join may span.
    else if (same(a, b)) pieces.push({ kind: 'common', lines: a });
    else if (style === 'diff3') pieces.push({ kind: 'conflict', base: base.slice(from, to), ours: a, theirs: b, crlf: baseCrlf && sideCrlf(ours, o) && sideCrlf(theirs, t) });
    else pieces.push(...refine(a, b, ours, theirs, o, t, baseCrlf));
    [o, t] = [o + a.length, t + b.length];
  }
  if (at < base.length) pieces.push({ kind: 'common', lines: base.slice(at) });
  const joined = style === 'merge' ? join(pieces) : pieces;
  // A one-sided change is plain text from here on (it already kept two conflicts apart).
  return mergeCommons(joined.map((p): Piece => (p.kind === 'taken' ? { kind: 'common', lines: p.lines } : p))) as Chunk[];
}

export function renderMerge(chunks: Chunk[], style: MergeStyle, labels: MergeLabels, size = 7): string {
  let out = '';
  for (const c of chunks) {
    if (c.kind === 'common') {
      out += c.lines.join('');
      continue;
    }
    const eol = c.crlf ? '\r\n' : '\n';
    const line = (l: string) => (l.endsWith('\n') ? l : `${l}${eol}`);
    // A label, even an empty one, follows a space (`merge-file -L ''`); the middle marker has none.
    const marker = (ch: string, label: string | null) => `${ch.repeat(size)}${label !== null ? ` ${label}` : ''}${eol}`;
    out += marker('<', labels.ours) + c.ours.map(line).join('');
    if (style === 'diff3') out += marker('|', labels.base) + c.base.map(line).join('');
    out += marker('=', null) + c.theirs.map(line).join('') + marker('>', labels.theirs);
  }
  return out;
}

export const conflictCount = (chunks: Chunk[]): number => chunks.filter((c): c is Conflict => c.kind === 'conflict').length;

/** Latin-1 texts in, the merged text (markers where it conflicts) and its conflict count out. */
export function mergeTexts(base: string, ours: string, theirs: string, style: MergeStyle, labels: MergeLabels): { text: string; conflicts: number } {
  const [b, o, t] = [splitLines(base), splitLines(ours), splitLines(theirs)];
  const chunks = mergeLines(b, o, t, style);
  return { text: renderMerge(chunks, style, labels), conflicts: conflictCount(chunks) };
}
