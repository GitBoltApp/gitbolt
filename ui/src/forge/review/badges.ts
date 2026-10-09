import type { DiffLine } from '../../diff/monaco/host';
import { shownItem, toMonacoSide, type PlacedItem, type Placement } from './model';

/** A file's badge in the diff panel's file list (spec 2026-10-08 §5): its threads and drafts, how
 * many threads are unresolved, and where a click opens the file. */
export interface FileBadge { count: number; threads: number; drafts: number; unresolved: number; first: Placement }

const unresolved = (it: PlacedItem) => it.kind === 'thread' && it.thread.resolvable && !it.thread.resolved;

/** `items` (a file's placements, in line order) as its badge, counting what shows a card
 * (`shownItem`): a click opens its first unresolved thread, else its first thread or draft.
 * Null: nothing on the file. */
export function fileBadge(all: readonly PlacedItem[] | undefined): FileBadge | null {
  const items = all?.filter(shownItem) ?? [];
  if (!items.length) return null;
  const open = items.filter(unresolved);
  const threads = items.filter((i) => i.kind === 'thread').length;
  return { count: items.length, threads, drafts: items.length - threads, unresolved: open.length, first: (open[0] ?? items[0]!).at };
}

/** "2 threads, 1 unresolved, 1 pending": the badge's accessible name. */
export function badgeLabel(b: FileBadge): string {
  const parts: string[] = [];
  if (b.threads) parts.push(b.threads === 1 ? '1 thread' : `${b.threads} threads`);
  if (b.unresolved) parts.push(`${b.unresolved} unresolved`);
  if (b.drafts) parts.push(`${b.drafts} pending`);
  return parts.join(', ');
}

/** Where the diff opens for a placement, as a note's `file:line` does: a range from its first line. */
export function placementLine(at: Placement): DiffLine {
  const side = toMonacoSide(at.side);
  return at.startLine !== null ? { side, line: at.startLine, end: at.line } : { side, line: at.line };
}
