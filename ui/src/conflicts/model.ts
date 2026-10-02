/**
 * The merge tool's model (spec #2 §13.3), pure. The output is the merged text: the common parts
 * as they are, each conflict region filled with its ticked lines, Current's first, then
 * Incoming's, each in file order. The tool starts with nothing ticked (plan 2D Deviation 14).
 *
 * Line endings (the 2D EOL ruling): every conflict line carries its own terminator, `\n`,
 * `\r\n`, or none on a file's last line, so the output is the lines joined as they are. The
 * file's EOL goes in only after a ticked line without one that another ticked line follows.
 */
export type Side = 'current' | 'incoming';
export type Segment =
  | { kind: 'common'; text: string }
  | { kind: 'conflict'; id: number; base: string[]; current: string[]; incoming: string[] };
export type ConflictSegment = Extract<Segment, { kind: 'conflict' }>;
export interface Pick { current: boolean[]; incoming: boolean[] }
export type Picks = Record<number, Pick>;
/** A region's place in the output: its 1-based first line and its line count. */
export interface OutRegion { id: number; start: number; lines: number }
export type CheckState = 'all' | 'none' | 'some';

const regions = (segs: Segment[]): ConflictSegment[] => segs.filter((s): s is ConflictSegment => s.kind === 'conflict');
const other = (side: Side): Side => (side === 'current' ? 'incoming' : 'current');
const newlines = (t: string) => t.split('\n').length - 1;
/** Whether any line of any region is ticked. */
export const anyPicked = (picks: Picks): boolean => Object.values(picks).some((p) => p.current.some(Boolean) || p.incoming.some(Boolean));
/** Whether `side` has lines in any region (else its Take all box has nothing to take). */
export const sideHasLines = (segs: Segment[], side: Side): boolean => regions(segs).some((s) => s[side].length > 0);

/** The file's EOL as text (`crlf` → `\r\n`, anything else `\n`). */
export const eolText = (eol: string): string => (eol === 'crlf' ? '\r\n' : '\n');

/** A region's ticked lines as output text: joined as they are, with `eol` after a line that has
 * no terminator of its own when another line follows it. */
export function regionText(lines: string[], eol = '\n'): string {
  return lines.map((l, i) => (i < lines.length - 1 && !l.endsWith('\n') ? l + eol : l)).join('');
}

export function emptyPicks(segs: Segment[]): Picks {
  const p: Picks = {};
  for (const s of regions(segs)) p[s.id] = { current: s.current.map(() => false), incoming: s.incoming.map(() => false) };
  return p;
}

export function regionLines(seg: ConflictSegment, pick: Pick): string[] {
  return [...seg.current.filter((_, i) => pick.current[i]), ...seg.incoming.filter((_, i) => pick.incoming[i])];
}

/** `eol`: the file's (`eolText`), put after a ticked line with no terminator of its own. */
export function buildOutput(segs: Segment[], picks: Picks, eol = '\n'): { text: string; regions: OutRegion[] } {
  let text = '';
  let line = 1;
  const out: OutRegion[] = [];
  for (const s of segs) {
    if (s.kind === 'common') {
      text += s.text;
      line += newlines(s.text);
      continue;
    }
    const lines = regionLines(s, picks[s.id] ?? { current: [], incoming: [] });
    out.push({ id: s.id, start: line, lines: lines.length });
    text += regionText(lines, eol);
    line += lines.length;
  }
  return { text, regions: out };
}

function stateOf(flags: boolean[]): CheckState {
  if (flags.every(Boolean)) return 'all';
  return flags.some(Boolean) ? 'some' : 'none';
}

export function hunkState(seg: ConflictSegment, pick: Pick, side: Side): CheckState {
  return seg[side].length === 0 ? 'all' : stateOf(pick[side]);
}

export function sideState(segs: Segment[], picks: Picks, side: Side): CheckState {
  const states = regions(segs).filter((s) => s[side].length > 0).map((s) => stateOf(picks[s.id]?.[side] ?? s[side].map(() => false)));
  if (states.length === 0 || states.every((s) => s === 'all')) return 'all';
  return states.every((s) => s === 'none') ? 'none' : 'some';
}

const withSide = (picks: Picks, id: number, side: Side, flags: boolean[]): Picks => ({ ...picks, [id]: { ...picks[id], [side]: flags } });

export function toggleHunk(picks: Picks, seg: ConflictSegment, side: Side): Picks {
  const all = hunkState(seg, picks[seg.id], side) === 'all' && seg[side].length > 0;
  return withSide(picks, seg.id, side, seg[side].map(() => !all));
}

export function toggleLine(picks: Picks, id: number, side: Side, index: number): Picks {
  const flags = (picks[id]?.[side] ?? []).map((f, i) => (i === index ? !f : f));
  return withSide(picks, id, side, flags);
}

export function takeAll(picks: Picks, segs: Segment[], side: Side, on: boolean): Picks {
  let p = picks;
  for (const s of regions(segs)) {
    p = withSide(p, s.id, side, s[side].map(() => on));
    if (on) p = withSide(p, s.id, other(side), s[other(side)].map(() => false));
  }
  return p;
}

export function unpickedCount(segs: Segment[], picks: Picks, edited: ReadonlySet<number>): number {
  return regions(segs).filter((s) => !edited.has(s.id) && regionLines(s, picks[s.id]).length === 0).length;
}

export function nextRegion(rs: OutRegion[], line: number, dir: 1 | -1): OutRegion | null {
  if (rs.length === 0) return null;
  const sorted = [...rs].sort((a, b) => a.start - b.start);
  if (dir === 1) return sorted.find((r) => r.start > line) ?? sorted[0];
  return [...sorted].reverse().find((r) => r.start < line) ?? sorted[sorted.length - 1];
}

/**
 * Whether a change at `offset` (replacing `length` characters with `text`), in the output as it
 * was before it, is inside the region `[a, b]`. Typing at the region's end, column 1 of the line
 * after it, isn't (review M1); typing at its start, or into an empty region, is. `openEnd`: the
 * region ends the file on an unterminated line, so typing at `b` is on its last line (N5).
 */
export function changeHits(offset: number, length: number, text: string, a: number, b: number, openEnd = false): boolean {
  if (length > 0 && offset < b && offset + length > a) return true;
  if (offset > a && offset < b) return true;
  // N5: a region ending the file on a line with no break: its end is still its last line.
  if (openEnd && offset === b && text.length > 0) return true;
  return offset === a && text.length > 0;
}

export function hasMarkers(text: string): boolean {
  return /^<{7}(?: |$)/m.test(text) && /^={7}$/m.test(text) && /^>{7}(?: |$)/m.test(text);
}
