import type * as MonacoNs from 'monaco-editor/editor/editor.api';
import type { DiffMode } from '../diffPrefs';
import { monaco } from './setup';

/**
 * Keeping the reader's place across a mode or toggle change (Hunk / Inline / Split, Ignore
 * whitespace, Word wrap), which relayouts the diff. The anchor is the line at the viewport's
 * vertical centre: a modified line, or an original one when the centre is in deleted lines (an
 * Inline/Hunk deleted-lines zone, or Split's filler facing them). `fraction` is how far down that
 * line the centre is, as a share of the line's height (its wrapped visual lines included), so a
 * line that wraps differently in the new layout keeps the same relative spot. A centre on Hunk's
 * "N hidden lines" bar anchors on the first line after the collapsed region. Scrolled to the very
 * top or bottom, the view stays there instead, so a small drift can't creep in.
 *
 * Coordinates: both editors of a diff share one scroll space. In Inline and Hunk the original
 * editor is the narrow old-line-number strip, laid out to match the modified side: its deleted
 * lines sit exactly where the modified side draws them in a view zone, with zones of its own
 * where they wrap. So an original line is found, and put back, through the original editor.
 */
export type ScrollAnchor = 'top' | 'bottom' | { side: 'modified' | 'original'; line: number; fraction: number };

type Diff = MonacoNs.editor.IStandaloneDiffEditor;
type Editor = MonacoNs.editor.ICodeEditor;
type Change = MonacoNs.editor.ILineChange;

const lineHeight = (e: Editor) => e.getOption(monaco.editor.EditorOption.lineHeight);
const lineCount = (e: Editor) => e.getModel()?.getLineCount() ?? 1;
const clamp01 = (x: number) => Math.max(0, Math.min(1, x));

/** The line after which a change's old lines show in Inline and Hunk mode: the line above the
 * change, or, for a pure deletion, the line Monaco reports (the one above the deleted lines). */
const zoneAfter = (c: Change) => (c.modifiedEndLineNumber === 0 ? c.modifiedStartLineNumber : c.modifiedStartLineNumber - 1);
const deletes = (c: Change) => c.originalEndLineNumber > 0;
const originalCount = (c: Change) => (deletes(c) ? c.originalEndLineNumber - c.originalStartLineNumber + 1 : 0);
const modifiedCount = (c: Change) => (c.modifiedEndLineNumber > 0 ? c.modifiedEndLineNumber - c.modifiedStartLineNumber + 1 : 0);

/** Line `n`'s own height: its wrapped visual lines, view zones excluded. Right for the last line,
 * and for a line followed by hidden ones (Monaco maps a hidden line onto the visible one above). */
function heightOf(e: Editor, n: number): number {
  const h = e.getBottomForLineNumber(n) - e.getTopForLineNumber(n);
  return h > 0 ? h : lineHeight(e);
}

const isVisible = (e: Editor, n: number) => e.getVisibleRanges().some((r) => r.startLineNumber <= n && n <= r.endLineNumber);

/**
 * The line at `y`, in two parts: the line whose box holds `y`, or, when `y` is in view zones, the
 * line right below them (the caller tells the two apart by `y < top(line)`).
 *
 * Monaco maps a hidden line (Hunk's collapsed regions) onto the last visible line above it, so a
 * hidden line shares that line's top. The search then lands on the last hidden line of a region:
 * `y` is either in the visible line above the region, or in the "hidden lines" bar below it, and
 * then the answer is the first line after the region, with the bar as the zone above it.
 */
function lineAt(e: Editor, y: number): number {
  const count = lineCount(e);
  let lo = 1;
  let hi = count;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (e.getTopForLineNumber(mid, true) <= y) lo = mid;
    else hi = mid - 1;
  }
  if (isVisible(e, lo)) return lo;
  const above = e.getVisibleRanges().filter((r) => r.startLineNumber <= lo).at(-1)?.endLineNumber ?? lo;
  return y < e.getBottomForLineNumber(above) ? above : Math.min(lo + 1, count);
}

/** The original line at `y` and how far down it `y` is, through the original editor. A line's
 * extent runs to the next line's top, so the wrap zones Monaco puts after a wrapped deleted line
 * (Inline) count as that line's. */
function originalAt(diff: Diff, y: number): { line: number; fraction: number } {
  const o = diff.getOriginalEditor();
  let line = lineAt(o, y);
  if (y < o.getTopForLineNumber(line) && line > 1) line -= 1;
  const top = o.getTopForLineNumber(line);
  return { line, fraction: clamp01((y - top) / extentOf(diff, line)) };
}

/**
 * An original line's extent in the original editor: to the next line's top (its wrap zones
 * included), or its own height for the last line. In Inline and Hunk the original strip also
 * faces a change's new lines, with a zone after its last old line (DiffEditorViewZones: the
 * change's `modifiedHeightInPx`, after `originalRange.endLineNumberExclusive - 1`). That zone
 * isn't the old line's: the old lines end where the new ones start, at the modified side's top of
 * the change's first new line. (In Split that top is level with the change's first old line, so
 * it's never below a deleted line's top, and nothing is cut.)
 */
function extentOf(diff: Diff, line: number): number {
  const o = diff.getOriginalEditor();
  const top = o.getTopForLineNumber(line);
  let end = line < lineCount(o) ? o.getTopForLineNumber(line + 1) : top + heightOf(o, line);
  const change = (diff.getLineChanges() ?? []).find((c) => deletes(c) && c.originalEndLineNumber === line && modifiedCount(c) > 0);
  if (change) {
    const added = diff.getModifiedEditor().getTopForLineNumber(change.modifiedStartLineNumber);
    if (added > top) end = Math.min(end, added);
  }
  return end > top ? end - top : lineHeight(o);
}

/** The anchor for `diff`'s current scroll position, laid out in `mode`. */
export function captureAnchor(diff: Diff, mode: DiffMode): ScrollAnchor | null {
  const m = diff.getModifiedEditor();
  if (!m.getModel()) return null;
  const height = m.getLayoutInfo().height;
  const top = m.getScrollTop();
  if (top <= 0) return 'top';
  if (top + height >= m.getScrollHeight() - 1) return 'bottom';
  const y = top + height / 2;
  const line = lineAt(m, y);
  const lineTop = m.getTopForLineNumber(line);
  if (y >= lineTop) return { side: 'modified', line, fraction: clamp01((y - lineTop) / heightOf(m, line)) };
  // In the zones above `line`: deleted lines, if a change put them there (Inline/Hunk: the zone
  // after the line above the change; Split: filler after the line above a deletion, or after the
  // last line of a modification with more old lines than new). Otherwise, such as Hunk's bar,
  // `line` itself: the first line below the zones.
  const deleted = (diff.getLineChanges() ?? []).find((c) => deletes(c) && (zoneAfter(c) === line - 1 || (mode === 'split' && c.modifiedEndLineNumber > 0 && c.modifiedEndLineNumber === line - 1)));
  if (!deleted) return { side: 'modified', line, fraction: 0 };
  const at = originalAt(diff, y);
  return { side: 'original', ...at };
}

/** The modified line that original line `line` corresponds to, when no change holds it: shifted
 * by every change above it (their new line count minus their old one). */
function modifiedLineFor(changes: Change[], line: number): number {
  let shift = 0;
  for (const c of changes) {
    const before = deletes(c) ? c.originalEndLineNumber < line : c.originalStartLineNumber < line;
    if (before) shift += modifiedCount(c) - originalCount(c);
  }
  return line + shift;
}

/** Where `anchor`'s centre point is in the diff's scroll space, laid out now. */
function anchorY(diff: Diff, anchor: Exclude<ScrollAnchor, 'top' | 'bottom'>): number {
  const m = diff.getModifiedEditor();
  if (anchor.side === 'modified') return m.getTopForLineNumber(anchor.line) + anchor.fraction * heightOf(m, anchor.line);
  const changes = diff.getLineChanges() ?? [];
  const inChange = changes.some((c) => deletes(c) && c.originalStartLineNumber <= anchor.line && anchor.line <= c.originalEndLineNumber);
  if (inChange) {
    const o = diff.getOriginalEditor();
    return o.getTopForLineNumber(anchor.line) + anchor.fraction * extentOf(diff, anchor.line);
  }
  // The change is gone (Ignore whitespace made the lines equal): the line is a modified one now.
  const line = Math.max(1, Math.min(lineCount(m), modifiedLineFor(changes, anchor.line)));
  return m.getTopForLineNumber(line) + anchor.fraction * heightOf(m, line);
}

/** Monaco's `ScrollType.Immediate`. */
const IMMEDIATE = 1;

/** Scrolls `diff` so `anchor` is at the viewport centre again (or at the top / bottom). */
export function restoreAnchor(diff: Diff, anchor: ScrollAnchor): void {
  const m = diff.getModifiedEditor();
  if (anchor === 'top') return m.setScrollTop(0, IMMEDIATE);
  if (anchor === 'bottom') return m.setScrollTop(m.getScrollHeight(), IMMEDIATE);
  m.setScrollTop(anchorY(diff, anchor) - m.getLayoutInfo().height / 2, IMMEDIATE);
}

/** Scrolls `diff` so `side`'s lines `line`-`end` are centred, or, taller than the view (with
 * `margin` above and below), so `line` is at the top below `margin`. */
export function revealRange(diff: Diff, at: { side: 'modified' | 'original'; line: number; end: number }, margin: number): void {
  const m = diff.getModifiedEditor();
  const top = anchorY(diff, { side: at.side, line: at.line, fraction: 0 });
  const bottom = anchorY(diff, { side: at.side, line: at.end, fraction: 1 });
  const height = m.getLayoutInfo().height;
  m.setScrollTop(bottom - top + 2 * margin > height ? top - margin : (top + bottom - height) / 2, IMMEDIATE);
}
