// The hex view's model (UX round 2, lane K): a binary's bytes as rows of 16 (8 when the view is
// narrow), shown in two Monaco editors side by side, the hex (bytes only, its offsets in the
// line-number gutter) and the text (the printable characters). Plain data, no Monaco: the editors
// (monaco/hexPanes.ts) and the tests share it. `per`: the bytes per row.
import type { HexSide } from '../api/gen/HexSide';

/** The bytes per row with room for them, and without. */
export const ROW_BYTES = 16;
export const NARROW_ROW_BYTES = 8;
/** The core's dump rows (`hex_lines`): always 16 bytes. */
const DUMP_ROW_BYTES = 16;

/** A hex row's width in characters: `per` bytes of 2 digits, a space between them and one more
 * between the row's two halves. */
export const hexRowChars = (per: number) => per * 3;

/** The bytes a core dump covers (`hexDump`'s `hexdump -C` lines): its first `shown`. */
export function dumpBytes(side: HexSide | null | undefined): Uint8Array {
  if (!side) return new Uint8Array(0);
  const out = new Uint8Array(side.shown);
  let n = 0;
  let at = 0;
  const dump = side.dump;
  while (n < out.length && at < dump.length) {
    const end = dump.indexOf('\n', at);
    const lineEnd = end < 0 ? dump.length : end;
    const count = Math.min(DUMP_ROW_BYTES, out.length - n);
    for (let j = 0; j < count; j++) {
      // The offset (8), two spaces, then `hexCol`'s layout.
      const c = at + 10 + hexCol(j, DUMP_ROW_BYTES);
      const v = c + 2 <= lineEnd ? parseInt(dump.slice(c, c + 2), 16) : NaN;
      if (Number.isNaN(v)) return out.subarray(0, n);
      out[n++] = v;
    }
    at = lineEnd + 1;
  }
  return out.subarray(0, n);
}

/** The 0-based column of byte `j`'s first digit in a hex row: `48 65 6c 6c 6f 20 77 6f  72 …`. */
export const hexCol = (j: number, per = ROW_BYTES) => 3 * j + (j >= per / 2 ? 1 : 0);

const HEX = Array.from({ length: 256 }, (_, b) => b.toString(16).padStart(2, '0'));
const CHAR = Array.from({ length: 256 }, (_, b) => (b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : '.'));

/** How many rows `n` bytes take. */
export const rowsOf = (n: number, per = ROW_BYTES) => Math.ceil(n / per);

/** The hex editor's text: one row per `per` bytes, padded with empty rows to `rows`. */
export function hexText(bytes: Uint8Array, per = ROW_BYTES, rows = rowsOf(bytes.length, per)): string {
  const lines: string[] = [];
  for (let at = 0; at < bytes.length; at += per) {
    let line = '';
    const end = Math.min(at + per, bytes.length);
    for (let i = at; i < end; i++) line += (i === at ? '' : i - at === per / 2 ? '  ' : ' ') + HEX[bytes[i]];
    lines.push(line);
  }
  while (lines.length < rows) lines.push('');
  return lines.join('\n');
}

/** The text editor's text: each row's bytes as characters ('.' for anything not printable
 * ASCII), padded with empty rows to `rows`. */
export function charText(bytes: Uint8Array, per = ROW_BYTES, rows = rowsOf(bytes.length, per)): string {
  const lines: string[] = [];
  for (let at = 0; at < bytes.length; at += per) {
    let line = '';
    const end = Math.min(at + per, bytes.length);
    for (let i = at; i < end; i++) line += CHAR[bytes[i]];
    lines.push(line);
  }
  while (lines.length < rows) lines.push('');
  return lines.join('\n');
}

/** Row `line`'s (1-based) offset, as 8 hex digits; `''` for a padding row past `size` bytes. */
export const offsetLabel = (line: number, size: number, per = ROW_BYTES) => {
  const at = (line - 1) * per;
  return at < size ? at.toString(16).padStart(8, '0') : '';
};

export type PaneKind = 'hex' | 'text';

/** A 1-based Monaco range. */
export interface CellRange { startLine: number; startColumn: number; endLine: number; endColumn: number }

/** The bytes [start, end) that a selection from (startLine, startColumn) to (endLine, endColumn)
 * covers in a pane, clamped to `size`: in the hex pane, every byte with a digit inside it. Null
 * when it covers none. */
export function selectedBytes(kind: PaneKind, r: CellRange, size: number, per = ROW_BYTES): [number, number] | null {
  const first = (x: number) => {
    // The first byte ending past column x (0-based).
    if (kind === 'text') return Math.min(x, per);
    let j = 0;
    while (j < per && hexCol(j, per) + 2 <= x) j++;
    return j;
  };
  const before = (x: number) => {
    // How many bytes start before column x (0-based).
    if (kind === 'text') return Math.min(x, per);
    let j = 0;
    while (j < per && hexCol(j, per) < x) j++;
    return j;
  };
  const start = (r.startLine - 1) * per + first(r.startColumn - 1);
  const end = Math.min(size, (r.endLine - 1) * per + before(r.endColumn - 1));
  return end > start ? [start, end] : null;
}

/** The cells of bytes [start, end) in a pane, as one range (a run over several rows spans them). */
export function byteRange(kind: PaneKind, start: number, end: number, per = ROW_BYTES): CellRange {
  const last = end - 1;
  const col = (j: number) => (kind === 'hex' ? hexCol(j, per) : j);
  const width = kind === 'hex' ? 2 : 1;
  return {
    startLine: Math.floor(start / per) + 1,
    startColumn: col(start % per) + 1,
    endLine: Math.floor(last / per) + 1,
    endColumn: col(last % per) + width + 1,
  };
}

/** A run of differing bytes [start, end): changed (on both sides), or only on one side, past the
 * other's end. */
export interface ByteRun { start: number; end: number; kind: 'changed' | 'added' | 'removed' }

/** Byte i against byte i: the runs where the sides differ. */
export function byteRuns(old: Uint8Array, neu: Uint8Array): ByteRun[] {
  const runs: ByteRun[] = [];
  const common = Math.min(old.length, neu.length);
  let i = 0;
  while (i < common) {
    if (old[i] === neu[i]) {
      i++;
      continue;
    }
    const start = i;
    while (i < common && old[i] !== neu[i]) i++;
    runs.push({ start, end: i, kind: 'changed' });
  }
  if (neu.length > common) runs.push({ start: common, end: neu.length, kind: 'added' });
  if (old.length > common) runs.push({ start: common, end: old.length, kind: 'removed' });
  return runs;
}

/** The changes, as blocks of adjacent changed rows (1-based, inclusive): what Next/Previous change
 * step through. */
export function changedRows(runs: ByteRun[], per = ROW_BYTES): { first: number; last: number }[] {
  const blocks: { first: number; last: number }[] = [];
  for (const r of runs) {
    const first = Math.floor(r.start / per) + 1;
    const last = Math.floor((r.end - 1) / per) + 1;
    const prev = blocks[blocks.length - 1];
    if (prev && first <= prev.last + 1) prev.last = Math.max(prev.last, last);
    else blocks.push({ first, last });
  }
  return blocks;
}

/** The runs (sorted, as `byteRuns` gives them) that overlap bytes [start, end), clipped to them.
 * The view colours only the rows around the viewport: 256 KB of alternating changes is 131 072
 * runs, too many to decorate at once. */
export function runsIn(runs: ByteRun[], start: number, end: number): ByteRun[] {
  let lo = 0;
  let hi = runs.length;
  // The first run ending past `start`. (Runs don't overlap and are in order, so their ends are too.)
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (runs[mid].end <= start) lo = mid + 1;
    else hi = mid;
  }
  const out: ByteRun[] = [];
  for (let i = lo; i < runs.length && runs[i].start < end; i++) out.push({ ...runs[i], start: Math.max(start, runs[i].start), end: Math.min(end, runs[i].end) });
  return out;
}

/** `blocks` with those less than `gap` rows apart merged: the scrollbar's marks, at most one or
 * two per pixel row however the changes fall. */
export function mergeBlocks(blocks: { first: number; last: number }[], gap: number): { first: number; last: number }[] {
  const out: { first: number; last: number }[] = [];
  for (const b of blocks) {
    const prev = out[out.length - 1];
    if (prev && b.first - prev.last <= gap) prev.last = b.last;
    else out.push({ ...b });
  }
  return out;
}

/** The block Next (or Previous) change goes to from row `line`, wrapping around as the diff
 * editor's does; -1 with none. */
export function stepChange(blocks: { first: number }[], line: number, dir: 'next' | 'previous'): number {
  if (!blocks.length) return -1;
  if (dir === 'next') {
    const i = blocks.findIndex((b) => b.first > line);
    return i < 0 ? 0 : i;
  }
  for (let i = blocks.length - 1; i >= 0; i--) if (blocks[i].first < line) return i;
  return blocks.length - 1;
}
