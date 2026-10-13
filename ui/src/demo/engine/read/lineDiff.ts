/**
 * A git-like line diff: Myers' minimal diff (jsdiff), then git's placement of ambiguous runs
 * (`compact`), then `-U<n>` hunks. Where it can differ from the core, which runs `git`:
 * - git's indent heuristic isn't ported. The core's porcelain `git diff` uses it, so WIP hunks on
 *   `}` or blank-line sliders can sit a few lines off; counts never differ.
 * - Among equal-cost paths, jsdiff can keep other copies of repeated lines than git's search does
 *   (same counts, different hunks).
 * - Past `MAX_EDIT_LENGTH` every remaining line counts as changed (about 1 to 1.5 s at the limit).
 */
import { diffArrays } from 'diff';

/** One change group: old lines [oldStart, oldEnd) became new lines [newStart, newEnd), 0-based. */
export interface Edit {
  oldStart: number;
  oldEnd: number;
  newStart: number;
  newEnd: number;
}

export interface HunkLine {
  kind: 'context' | 'del' | 'add';
  /** The line's bytes (Latin-1), with its newline when it has one. */
  text: string;
  /** 1-based number on the old side (context and deletions), else 0. */
  old: number;
  /** 1-based number on the new side (context and additions), else 0. */
  new: number;
  /** Followed by `\ No newline at end of file`. */
  noEol: boolean;
}

export interface DiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: HunkLine[];
}

/** Past this many edits, the search gives up and every remaining line counts as changed. */
const MAX_EDIT_LENGTH = 4_000;

export function splitLines(text: string): string[] {
  const out: string[] = [];
  let start = 0;
  for (;;) {
    const nl = text.indexOf('\n', start);
    if (nl < 0) break;
    out.push(text.slice(start, nl + 1));
    start = nl + 1;
  }
  if (start < text.length) out.push(text.slice(start));
  return out;
}

export function diffLines(a: string[], b: string[]): Edit[] {
  const n = a.length;
  const m = b.length;
  let pre = 0;
  while (pre < n && pre < m && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < n - pre && suf < m - pre && a[n - 1 - suf] === b[m - 1 - suf]) suf++;
  const changedA = new Uint8Array(n);
  const changedB = new Uint8Array(m);
  const inA = new Set<string>();
  const inB = new Set<string>();
  for (let i = pre; i < n - suf; i++) inA.add(a[i]);
  for (let j = pre; j < m - suf; j++) inB.add(b[j]);
  const ids = new Map<string, number>();
  const id = (s: string): number => {
    let v = ids.get(s);
    if (v === undefined) {
      v = ids.size;
      ids.set(s, v);
    }
    return v;
  };
  const keptA: number[] = [];
  const atA: number[] = [];
  for (let i = pre; i < n - suf; i++) {
    if (inB.has(a[i])) {
      keptA.push(id(a[i]));
      atA.push(i);
    } else {
      changedA[i] = 1;
    }
  }
  const keptB: number[] = [];
  const atB: number[] = [];
  for (let j = pre; j < m - suf; j++) {
    if (inA.has(b[j])) {
      keptB.push(id(b[j]));
      atB.push(j);
    } else {
      changedB[j] = 1;
    }
  }
  const parts = keptA.length && keptB.length ? diffArrays(keptA, keptB, { maxEditLength: MAX_EDIT_LENGTH }) : undefined;
  if (parts === undefined) {
    for (const i of atA) changedA[i] = 1;
    for (const j of atB) changedB[j] = 1;
  } else {
    let i = 0;
    let j = 0;
    for (const p of parts) {
      if (p.added) for (let k = 0; k < p.count; k++) changedB[atB[j++]] = 1;
      else if (p.removed) for (let k = 0; k < p.count; k++) changedA[atA[i++]] = 1;
      else {
        i += p.count;
        j += p.count;
      }
    }
  }
  compact(a, changedA, changedB);
  compact(b, changedB, changedA);
  return edits(changedA, changedB);
}

/**
 * Places each run of changed lines in `changed` where git places it (without the indent heuristic),
 * in place and without changing the counts. A run can move a line down when the line after it
 * equals its first line, or up when the line before it equals its last; runs that meet become one.
 * Each run then sits as low as it can, unless a position in its reach puts it in the same gap
 * between unchanged lines as a change on the `other` side (one change group, as git shows it):
 * then the lowest such position. `diffLines` compacts the old side against the new side's marks
 * as the search left them, then the new side against the old side's compacted marks, as git does.
 */
export function compact(lines: string[], changed: Uint8Array, other?: Uint8Array): void {
  const n = lines.length;
  // otherGap[g]: the other side changes something between its unchanged lines g - 1 and g.
  let otherGap: Uint8Array | undefined;
  if (other) {
    otherGap = new Uint8Array(other.length + 1);
    let kept = 0;
    for (let j = 0; j < other.length; j++) {
      if (other[j]) otherGap[kept] = 1;
      else kept++;
    }
  }
  let above = 0; // changed lines before the current run
  let s = 0;
  for (;;) {
    while (s < n && !changed[s]) s++;
    if (s >= n) return;
    let e = s;
    while (e < n && changed[e]) e++;
    let top: number;
    for (;;) {
      const size = e - s;
      while (s > 0 && lines[s - 1] === lines[e - 1]) {
        changed[--s] = 1;
        changed[--e] = 0;
        while (s > 0 && changed[s - 1]) {
          s--;
          above--;
        }
      }
      top = s;
      while (e < n && lines[e] === lines[s]) {
        changed[s++] = 0;
        changed[e++] = 1;
        while (e < n && changed[e]) e++;
      }
      if (e - s === size) break;
    }
    if (otherGap) {
      // A run starting at p has p - above unchanged lines before it.
      let p = s;
      while (p > top && !otherGap[p - above]) p--;
      if (p < s && otherGap[p - above]) {
        changed.fill(0, s, e);
        e = p + e - s;
        s = p;
        changed.fill(1, s, e);
      }
    }
    above += e - s;
    s = e;
  }
}

function edits(ca: Uint8Array, cb: Uint8Array): Edit[] {
  const out: Edit[] = [];
  let i = 0;
  let j = 0;
  while (i < ca.length || j < cb.length) {
    if ((i < ca.length && ca[i]) || (j < cb.length && cb[j])) {
      const oldStart = i;
      const newStart = j;
      while (i < ca.length && ca[i]) i++;
      while (j < cb.length && cb[j]) j++;
      out.push({ oldStart, oldEnd: i, newStart, newEnd: j });
    } else {
      i++;
      j++;
    }
  }
  return out;
}

export function countEdits(es: Edit[]): [number, number] {
  let added = 0;
  let deleted = 0;
  for (const e of es) {
    added += e.newEnd - e.newStart;
    deleted += e.oldEnd - e.oldStart;
  }
  return [added, deleted];
}

export function unifiedHunks(a: string[], b: string[], es: Edit[], context = 3): DiffHunk[] {
  const out: DiffHunk[] = [];
  const lastA = a.length - 1;
  const lastB = b.length - 1;
  const eolA = (i: number) => i === lastA && !a[i].endsWith('\n');
  const eolB = (j: number) => j === lastB && !b[j].endsWith('\n');
  let k = 0;
  while (k < es.length) {
    let last = k;
    while (last + 1 < es.length && es[last + 1].oldStart - es[last].oldEnd <= 2 * context) last++;
    const first = es[k];
    const end = es[last];
    const oldFrom = Math.max(0, first.oldStart - context);
    const oldTo = Math.min(a.length, end.oldEnd + context);
    const newFrom = first.newStart - (first.oldStart - oldFrom);
    const lines: HunkLine[] = [];
    let o = oldFrom;
    let nw = newFrom;
    const contextTo = (stop: number) => {
      for (; o < stop; o++, nw++) lines.push({ kind: 'context', text: a[o], old: o + 1, new: nw + 1, noEol: eolA(o) });
    };
    for (let x = k; x <= last; x++) {
      const e = es[x];
      contextTo(e.oldStart);
      for (let i = e.oldStart; i < e.oldEnd; i++) lines.push({ kind: 'del', text: a[i], old: i + 1, new: 0, noEol: eolA(i) });
      for (let j = e.newStart; j < e.newEnd; j++) lines.push({ kind: 'add', text: b[j], old: 0, new: j + 1, noEol: eolB(j) });
      o = e.oldEnd;
      nw = e.newEnd;
    }
    contextTo(oldTo);
    const oldLines = oldTo - oldFrom;
    const newLines = nw - newFrom;
    out.push({ oldStart: oldLines === 0 ? oldFrom : oldFrom + 1, oldLines, newStart: newLines === 0 ? newFrom : newFrom + 1, newLines, lines });
    k = last + 1;
  }
  return out;
}
