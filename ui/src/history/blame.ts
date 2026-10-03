import type { BlameHunk } from '../api/gen/BlameHunk';

/** Consecutive lines last changed by one commit (spec #3 §3.10): one row of the gutter. */
export interface BlameGroup { sha: string; start: number; lines: number }

/** git's porcelain hunks, merged where one commit's lines run on, in line order. */
export function groupBlame(hunks: readonly BlameHunk[]): BlameGroup[] {
  const out: BlameGroup[] = [];
  for (const h of [...hunks].sort((x, y) => x.start - y.start)) {
    const last = out.at(-1);
    if (last && last.sha === h.sha && last.start + last.lines === h.start) last.lines += h.lines;
    else out.push({ sha: h.sha, start: h.start, lines: h.lines });
  }
  return out;
}

/** The groups that overlap lines `first`..`last` (1-based), by binary search. */
export function visibleGroups(groups: readonly BlameGroup[], first: number, last: number): BlameGroup[] {
  if (last < first) return [];
  let lo = 0, hi = groups.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (groups[mid].start + groups[mid].lines - 1 < first) lo = mid + 1;
    else hi = mid;
  }
  const out: BlameGroup[] = [];
  for (let i = lo; i < groups.length && groups[i].start <= last; i++) out.push(groups[i]);
  return out;
}

/** A stable lane-palette index per commit (FNV-1a over the sha, as `Avatar` picks one per person). */
export function colorIndex(sha: string, n: number): number {
  let h = 2166136261;
  for (let i = 0; i < sha.length; i++) {
    h ^= sha.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) % n;
}
