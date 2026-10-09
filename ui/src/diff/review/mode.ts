import type { DiffSide } from '../../api/gen/DiffSide';
import type { ForgeDiscussion } from '../../api/gen/ForgeDiscussion';
import type { ForgeKind } from '../../api/gen/ForgeKind';
import type { ReviewDraft } from '../../api/gen/ReviewDraft';
import type { ReviewSession } from '../../forge/mrStore';
import { compareStale, numberOf, shownItem, sideOf, toMonacoSide, type CommentableFile, type PlacedItem } from '../../forge/review/model';
import type { DiffTarget, Selection } from '../../repo/store';
import type { ReviewZoneItem } from '../monaco/reviewZones';
import type { OpenBox } from './store';

/**
 * Review mode in the source diff (spec 2026-10-08 §2). Pure.
 */

/** Off, or on: `stale` when the session's diff refs aren't the Compare's head (its lines aren't the
 * forge's: no gutter, no cards); `updating` with it when the MR's head is the Compare's and the
 * refs are behind (the forge hasn't caught up with a push yet: wait), else the MR moved on
 * (Compare again); `file`: the lines that take a comment, null until the MR's diff is read or
 * when the forge sent none (`tooLarge`). */
export type ReviewModeOf = { on: false } | { on: true; stale: boolean; updating?: boolean; tooLarge: boolean; file: CommentableFile | null };
const OFF: ReviewModeOf = { on: false };

/** On when the open diff is the session's Compare (the same base and head commits, that way
 * round) for a file of the MR. `mrHead`: the MR's head as its detail last said. */
export function reviewModeOf(s: ReviewSession | null, sel: Selection | null | undefined, target: Pick<DiffTarget, 'path' | 'view'>, mrHead: string | null = null): ReviewModeOf {
  if (!s?.compare || target.view !== 'diff' || sel?.kind !== 'compare' || sel.from !== s.compare.from || sel.to !== s.compare.to) return OFF;
  // GitLab's diff refs lag a push: the MR's detail has the new head, the refs still the last one.
  if (compareStale(s)) return { on: true, stale: true, ...(mrHead === s.compare.to && { updating: true }), tooLarge: false, file: null };
  const read = s.diffHead !== null && s.diffHead === s.compare.to;
  const file = read ? s.files[target.path] : undefined;
  if (read && !file) return OFF;
  return { on: true, stale: false, tooLarge: !!file?.tooLarge, file: file && !file.tooLarge ? file : null };
}

export type ReviewEntry =
  | { kind: 'thread'; item: ReviewZoneItem; thread: ForgeDiscussion; outdated: boolean }
  | { kind: 'draft'; item: ReviewZoneItem; draft: ReviewDraft; outdated: boolean }
  | { kind: 'box'; item: ReviewZoneItem; box: OpenBox };

const RANK = { thread: 0, draft: 1, box: 2 } as const;

/** One file's cards, in line order (at one line: its threads, then drafts, then boxes): a thread
 * with a comment, a draft, an open box. Threads and drafts are where Next / Previous thread stop. */
export function reviewEntries(placed: readonly PlacedItem[], boxes: readonly OpenBox[]): ReviewEntry[] {
  const zone = (key: string, side: DiffSide, line: number, startLine: number | null, stop: boolean): ReviewZoneItem => ({ key, side: toMonacoSide(side), line, startLine, stop });
  const out: ReviewEntry[] = [];
  for (const p of placed.filter(shownItem)) {
    if (p.kind === 'draft') out.push({ kind: 'draft', item: zone(`d:${p.draft.id}`, p.at.side, p.at.line, p.at.startLine, true), draft: p.draft, outdated: p.at.outdated });
    else out.push({ kind: 'thread', item: zone(`t:${p.thread.id}`, p.at.side, p.at.line, p.at.startLine, true), thread: p.thread, outdated: p.at.outdated });
  }
  for (const box of boxes) {
    const side = sideOf(box.anchor.end);
    const start = box.anchor.start && sideOf(box.anchor.start) === side ? numberOf(box.anchor.start) : null;
    out.push({ kind: 'box', item: zone(`b:${box.key}`, side, numberOf(box.anchor.end), start, false), box });
  }
  return out.map((e, i) => [e, i] as const).sort(([a, i], [b, j]) => a.item.line - b.item.line || RANK[a.kind] - RANK[b.kind] || i - j).map(([e]) => e);
}

/** Suggest change's block: GitHub's `suggestion` replaces the commented lines; GitLab's
 * `suggestion:-N+0` the commented line and the N above it. A longer fence when the code has one. */
export function suggestionBlock(kind: ForgeKind, lines: readonly string[]): string {
  const fence = lines.some((l) => l.includes('```')) ? '````' : '```';
  const info = kind === 'gitlab' ? `suggestion:-${Math.max(0, lines.length - 1)}+0` : 'suggestion';
  return `${fence}${info}\n${lines.join('\n')}\n${fence}`;
}

/** A side's commentable line numbers (`CommentableFile.old` / `.new`), as a set. */
export const lineSet = (byLine: Record<number, unknown>): ReadonlySet<number> => new Set(Object.keys(byLine).map(Number));
