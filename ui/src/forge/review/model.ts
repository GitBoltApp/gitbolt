import type { DiffPosition } from '../../api/gen/DiffPosition';
import type { DiffRefs } from '../../api/gen/DiffRefs';
import type { DiffSide } from '../../api/gen/DiffSide';
import type { ForgeDiscussion } from '../../api/gen/ForgeDiscussion';
import type { ForgeMr } from '../../api/gen/ForgeMr';
import type { ReviewAnchor } from '../../api/gen/ReviewAnchor';
import type { ReviewDraft } from '../../api/gen/ReviewDraft';
import type { ReviewFile } from '../../api/gen/ReviewFile';
import type { ReviewLine } from '../../api/gen/ReviewLine';
import type { ReviewSession } from '../mrStore';

/**
 * Review comments (spec 2026-10-08 §1, §2): which lines of an MR's diff take a comment, where a
 * new comment goes, and where the MR's threads and the user's drafts sit. Pure.
 */

/** One file's lines that take a comment: removed and unchanged lines by old number, added and
 * unchanged lines by new number (so both copies of an unchanged line take one). */
export interface CommentableFile {
  path: string;
  oldPath: string;
  /** The forge sent no diff for it: no line takes a comment. */
  tooLarge: boolean;
  /** In diff order. */
  lines: ReviewLine[];
  old: Record<number, ReviewLine>;
  new: Record<number, ReviewLine>;
}

/** The side a comment on `l` is on: a removed line's is the old one, the others' the new one. */
export const sideOf = (l: ReviewLine): DiffSide => (l.kind === 'removed' ? 'old' : 'new');
/** `l`'s number on `sideOf(l)`. */
export const numberOf = (l: ReviewLine): number => (l.kind === 'removed' ? l.oldLine : l.newLine);
export const toMonacoSide = (side: DiffSide): 'original' | 'modified' => (side === 'old' ? 'original' : 'modified');
export const fromMonacoSide = (side: 'original' | 'modified'): DiffSide => (side === 'original' ? 'old' : 'new');

export function commentableIndex(file: ReviewFile): CommentableFile {
  const out: CommentableFile = { path: file.path, oldPath: file.oldPath, tooLarge: file.tooLarge, lines: file.lines, old: {}, new: {} };
  for (const l of file.lines) {
    if (l.kind !== 'added') out.old[l.oldLine] = l;
    if (l.kind !== 'removed') out.new[l.newLine] = l;
  }
  return out;
}

export function lineAt(file: CommentableFile | undefined, side: DiffSide, line: number): ReviewLine | null {
  return file?.[side][line] ?? null;
}

/** Two lines in a row of `lines` are in one hunk: neither counter jumps. */
const sameHunk = (a: ReviewLine, b: ReviewLine) => b.oldLine - a.oldLine <= 1 && b.newLine - a.newLine <= 1;

/**
 * Where a comment on lines `from`..`to` (either order) of `side` goes: the first and last of them
 * that take a comment, within the hunk of the last one (a range can't span lines the diff doesn't
 * show). The rendered diff's blocks clip to the forge's lines this way. Null: none takes one.
 */
export function anchorFor(file: CommentableFile, side: DiffSide, from: number, to: number): ReviewAnchor | null {
  const [lo, hi] = from <= to ? [from, to] : [to, from];
  const at = (l: ReviewLine) => (side === 'old' ? l.oldLine : l.newLine);
  let hunk = 0;
  const hunks = file.lines.map((l, i) => (i > 0 && !sameHunk(file.lines[i - 1]!, l) ? ++hunk : hunk));
  const picked = file.lines.flatMap((l, i) => (file[side][at(l)] === l && at(l) >= lo && at(l) <= hi ? [{ l, h: hunks[i]! }] : []));
  const last = picked[picked.length - 1];
  if (!last) return null;
  const run = picked.filter((p) => p.h === last.h);
  return { path: file.path, oldPath: file.oldPath, start: run.length > 1 ? run[0]!.l : null, end: last.l };
}

/** The session's diff refs aren't its Compare's head (the MR moved on, or the forge is still
 * catching up with a push): the forge's lines and positions aren't the Compare's. */
export const compareStale = (s: ReviewSession): boolean => s.compare !== null && s.refs !== null && s.refs.headSha !== s.compare.to;

/**
 * The lines a comment on `a` covers on the side it lands on (`sideOf(a.end)`), in that side's
 * numbers only: where its box opens, what its "+" says, and what Suggest change takes. The rule:
 * the last line decides the side (as the forge places it). Ending on a removed line, it's the old
 * side, and every line of the range has an old number. Ending on an unchanged or added line, it's
 * the new side, even dragged on the old one (an unchanged line there): it starts at its first line
 * the new side has, so a removed line it starts on is left out of the numbers (the forge still
 * gets the whole range).
 */
export function anchorSpan(file: CommentableFile, a: ReviewAnchor): { side: DiffSide; from: number; to: number } {
  const side = sideOf(a.end);
  const to = numberOf(a.end);
  const start = a.start;
  if (!start) return { side, from: to, to };
  if (side === 'old') return { side, from: start.oldLine, to };
  if (start.kind !== 'removed') return { side, from: start.newLine, to };
  const i = file.lines.findIndex((l) => l.kind === start.kind && l.oldLine === start.oldLine);
  const first = i < 0 ? undefined : file.lines.slice(i).find((l) => l.kind !== 'removed');
  return { side, from: first && first.newLine <= to ? first.newLine : to, to };
}

/** Where a thread or a draft sits in the diff view. */
export interface Placement {
  path: string;
  side: DiffSide;
  /** Its last line, on `side`. */
  line: number;
  /** A range's first line on `side`; null for one line. */
  startLine: number | null;
  outdated: boolean;
}

/** The forge couldn't carry it to the MR's head (GitHub), or it's against an older head (GitLab). */
export function isOutdated(pos: DiffPosition, refs: DiffRefs | null): boolean {
  return pos.outdated === true || (refs !== null && pos.headSha !== undefined && pos.headSha !== refs.headSha);
}

/**
 * Where `pos` sits in the diff of `file`: its new line, else (a removed line) its old one. An
 * outdated published thread sits nowhere (neither forge reports a current line for it: it stays
 * on the timeline); an outdated draft sits at its line, marked outdated, while that line is still
 * one of the diff's.
 */
export function placeOf(pos: DiffPosition, refs: DiffRefs | null, file: CommentableFile | undefined, draft: boolean): Placement | null {
  const side: DiffSide = pos.line !== null ? 'new' : 'old';
  const line = side === 'new' ? pos.line : pos.oldLine;
  if (line === null) return null;
  const outdated = isOutdated(pos, refs);
  if (outdated && (!draft || !lineAt(file, side, line))) return null;
  const start = side === 'new' ? pos.startLine : pos.startOldLine;
  return { path: pos.path, side, line, startLine: start !== null && start < line ? start : null, outdated };
}

export type PlacedItem = { kind: 'thread'; thread: ForgeDiscussion; at: Placement } | { kind: 'draft'; draft: ReviewDraft; at: Placement };

/** A card shows for it: a draft, or a thread with a comment (one of system notes alone shows none,
 * in either view, and the file list's badge doesn't count it). */
export const shownItem = (it: PlacedItem): boolean => it.kind === 'draft' || it.thread.notes.some((n) => !n.system);

export interface ReviewPlacements {
  /** By file (its new path), in line order. */
  byPath: Record<string, PlacedItem[]>;
  /** Drafts that sit on no line of this diff (no position, outdated and gone, or on a file the
   * diff doesn't have): Submit review… lists them, the chip counts them with the placed ones,
   * and the review sends them. */
  unplacedDrafts: ReviewDraft[];
}

export function placeReview(s: ReviewSession, threads: readonly ForgeDiscussion[]): ReviewPlacements {
  const byPath: Record<string, PlacedItem[]> = {};
  const put = (item: PlacedItem) => (byPath[item.at.path] ??= []).push(item);
  for (const t of threads) {
    const p = t.notes.find((n) => n.position)?.position;
    const at = p ? placeOf(p, s.refs, s.files[p.path], false) : null;
    if (at) put({ kind: 'thread', thread: t, at });
  }
  const unplacedDrafts: ReviewDraft[] = [];
  for (const d of s.drafts) {
    const at = d.position ? placeOf(d.position, s.refs, s.files[d.position.path], true) : null;
    // Once the diff is read, a file it doesn't have shows no draft: listed with the others.
    if (at && (s.diffHead === null || s.files[at.path])) put({ kind: 'draft', draft: d, at });
    else unplacedDrafts.push(d);
  }
  for (const items of Object.values(byPath)) items.sort((a, b) => a.at.line - b.at.line || (a.at.side === b.at.side ? 0 : a.at.side === 'old' ? -1 : 1));
  return { byPath, unplacedDrafts };
}

/**
 * Whether a session stays (spec §1): until its first refresh answers, yes (unless it failed:
 * nothing is known to be pending then); while a review is pending (drafts, or GitHub's pending
 * review), yes; else not once its MR merged or closed, and otherwise while its Compare is shown.
 */
export function reviewAlive(s: ReviewSession, compareOpen: boolean, mr: ForgeMr | null): boolean {
  if ((!s.loaded && s.error === null) || s.drafts.length > 0 || s.pendingReview !== null) return true;
  if (mr && (mr.state === 'merged' || mr.state === 'closed')) return false;
  return compareOpen;
}
