import type { DiffLine } from '../../diff/monaco/host';
import { shownItem, toMonacoSide, type PlacedItem, type Placement } from './model';

/** A file's badge in the diff panel's file list (spec 2026-10-08 §5): its threads and drafts, how
 * many threads are unresolved, and where its clicks open the file (`stops`, in turn; `sig`: what
 * they are, so a change starts the turn over). */
export interface FileBadge { count: number; threads: number; drafts: number; unresolved: number; stops: Placement[]; sig: string }

const unresolved = (it: PlacedItem) => it.kind === 'thread' && it.thread.resolvable && !it.thread.resolved;

/** `items` (a file's placements, in line order) as its badge, counting what shows a card
 * (`shownItem`). Its clicks go to the unresolved threads first, the ones still to deal with, then
 * to the rest (resolved threads, drafts), each in line order. Null: nothing on the file. */
export function fileBadge(all: readonly PlacedItem[] | undefined): FileBadge | null {
  const items = all?.filter(shownItem) ?? [];
  if (!items.length) return null;
  const open = items.filter(unresolved);
  const threads = items.filter((i) => i.kind === 'thread').length;
  const order = [...open, ...items.filter((i) => !unresolved(i))];
  const sig = order.map((i) => (i.kind === 'thread' ? `t${i.thread.id}${i.thread.resolved ? '+' : ''}` : `d${i.draft.id}`) + `@${i.at.side}${i.at.line}`).join(' ');
  return { count: items.length, threads, drafts: items.length - threads, unresolved: open.length, stops: order.map((i) => i.at), sig };
}

/** Where each file's badge went last, by tab, review and path, for the app's session. */
const turns = new Map<string, { sig: string; at: number }>();

/** Where a click on `badge` (the file `key`'s) opens it: its first stop, then each next one, round
 * to the first again. A change to what's on the file starts over at its first. */
export function nextStop(key: string, badge: FileBadge): Placement {
  const was = turns.get(key);
  const at = was && was.sig === badge.sig ? (was.at + 1) % badge.stops.length : 0;
  turns.set(key, { sig: badge.sig, at });
  return badge.stops[at]!;
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
