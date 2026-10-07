import type { DiffPosition } from '../../api/gen/DiffPosition';
import type { DiffLine } from '../../diff/monaco/host';

/** Where a note opens the diff: its new line, else (a note on a removed line) its old one; a
 * range's lines, from its first, when that has a number on the same side. A range from a removed
 * line to an added one (GitLab's) is its last line alone: there's no new line to start from. */
export function noteLine(pos: DiffPosition): DiffLine | null {
  const side = pos.line !== null ? 'modified' : pos.oldLine !== null ? 'original' : null;
  if (!side) return null;
  const [start, end] = side === 'modified' ? [pos.startLine, pos.line!] : [pos.startOldLine, pos.oldLine!];
  return start !== null && start < end ? { side, line: start, end } : { side, line: end };
}

/** A note's `path:line`, or `path:start-end` for a range (`noteLine`'s lines). */
export function noteWhere(pos: DiffPosition): string {
  const at = noteLine(pos);
  return at ? `${pos.path}:${at.line}${at.end !== undefined ? `-${at.end}` : ''}` : pos.path;
}
