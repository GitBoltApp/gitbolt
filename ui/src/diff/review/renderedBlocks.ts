import type { DiffSide } from '../../api/gen/DiffSide';
import type { ReviewAnchor } from '../../api/gen/ReviewAnchor';
import { anchorFor, anchorSpan, numberOf, sideOf, type CommentableFile, type PlacedItem } from '../../forge/review/model';
import { openTop } from '../changeNav';
import { STEP_MARGIN } from '../changeStepper';
import type { DiffLine } from '../monaco/host';
import type { OpenBox } from './store';

/**
 * Review comments in the rendered Markdown diff (spec 2026-10-08 §3): its blocks as the renderer
 * marks them (`data-src-id`, `data-src-new`, `data-src-old`: markdown/render.tsx), where a line
 * sits among them, and where the pane scrolls to show one.
 */

/** A rendered block: its id, its lines on each side it shows, its place in the page. */
export interface SrcBlock { id: number; new: [number, number] | null; old: [number, number] | null; order: number }

/** "3-7" as [3, 7]; null for anything else. */
export function srcRange(v: string | undefined): [number, number] | null {
  const m = v ? /^(\d+)-(\d+)$/.exec(v) : null;
  return m ? [Number(m[1]), Number(m[2])] : null;
}

/** The block elements under `root`, in page order, leaving out any inside a review slot (a
 * thread's own Markdown, whose blocks carry ids of their own that may match the page's). */
function blockElements(root: ParentNode): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>('[data-src-id]')].filter((el) => !el.closest('[data-review-slot]'));
}

/** The blocks under `root`, in page order (`order`: the index among them), leaving out any
 * inside a review slot. */
export function scanBlocks(root: ParentNode): SrcBlock[] {
  return blockElements(root).map(toBlock);
}

const toBlock = (el: HTMLElement, order: number): SrcBlock => ({ id: Number(el.dataset.srcId), new: srcRange(el.dataset.srcNew), old: srcRange(el.dataset.srcOld), order });

const spanOf = (r: [number, number]) => r[1] - r[0];

/**
 * The block line `line` of `side` sits under: the innermost one holding it (the shortest range;
 * of two alike, the later in the page, which is inside the other). A line in no block (raw HTML,
 * a definition, a blank line) sits under the last block before it; before the first, nowhere.
 * Front matter is a block (its table, with the front matter's lines): a thread on a key shows
 * under the table.
 */
export function blockFor(blocks: readonly SrcBlock[], side: DiffSide, line: number): SrcBlock | null {
  let best: SrcBlock | null = null;
  let before: SrcBlock | null = null;
  for (const b of blocks) {
    const r = b[side];
    if (!r) continue;
    if (r[0] <= line && line <= r[1]) {
      if (!best || spanOf(r) <= spanOf(best[side]!)) best = b;
    } else if (r[1] < line && (!before || r[1] >= before[side]![1])) before = b;
  }
  return best ?? before;
}

/** A block's slot for one side's items: a split view has the block once per column. */
export const slotKey = (id: number, side: DiffSide): string => `${id}:${side}`;

/** Which slot each thread and draft shows in: its side's block holding its last line (`blockFor`),
 * in the order given (the placements' line order). */
export function assignItems(blocks: readonly SrcBlock[], items: readonly PlacedItem[]): Map<string, PlacedItem[]> {
  const out = new Map<string, PlacedItem[]>();
  for (const it of items) {
    const b = blockFor(blocks, it.at.side, it.at.line);
    if (!b) continue;
    const k = slotKey(b.id, it.at.side);
    out.set(k, [...(out.get(k) ?? []), it]);
  }
  return out;
}

/** Which slot each open comment box shows in: as its draft will (`assignItems`), under its side's
 * block holding its last line; before any block holds one, under the first block of its side. */
export function assignBoxes(blocks: readonly SrcBlock[], boxes: readonly OpenBox[]): Map<string, OpenBox[]> {
  const out = new Map<string, OpenBox[]>();
  for (const box of boxes) {
    const side = sideOf(box.anchor.end);
    const b = blockFor(blocks, side, numberOf(box.anchor.end)) ?? blocks.find((x) => x[side]);
    if (!b) continue;
    const k = slotKey(b.id, side);
    out.set(k, [...(out.get(k) ?? []), box]);
  }
  return out;
}

/** Where `pane` scrolls to show line `at` (a note's `file:line`, from its first line): its
 * block, placed as `openTop` places the first change. Null: no block for it has rendered yet. */
export function blockTop(pane: HTMLElement, at: DiffLine): number | null {
  const side: DiffSide = at.side === 'original' ? 'old' : 'new';
  const els = blockElements(pane);
  const b = blockFor(els.map(toBlock), side, at.line);
  const el = b && els[b.order];
  if (!el) return null;
  const origin = pane.getBoundingClientRect().top - pane.scrollTop;
  const r = el.getBoundingClientRect();
  return openTop({ top: r.top - origin, bottom: r.bottom - origin }, pane.clientHeight, STEP_MARGIN);
}

/** What a block's "+" comments on: `key`, the block's slot (`slotKey`); `side`, `from`/`to`: the
 * side and lines the comment lands on (`anchorSpan`). */
export interface BlockTarget { key: string; side: DiffSide; anchor: ReviewAnchor; from: number; to: number; label: string }

/**
 * The "+" of block `el`: the block's lines on the new side, else (a removed block, or a split
 * view's old column) the old side's, clipped to the lines the forge takes (`anchorFor`: within
 * one hunk). Its side and numbers are the ones the comment lands on (`anchorSpan`): an old-column
 * block ending on an unchanged line lands on the new side, its box under the new column's block.
 * `key`: the block's own (the side it shows). Null: none of its lines takes a comment (the block
 * doesn't touch the MR's diff).
 */
export function blockTarget(file: CommentableFile, el: HTMLElement): BlockTarget | null {
  const neu = srcRange(el.dataset.srcNew);
  const shows: DiffSide = neu ? 'new' : 'old';
  const r = neu ?? srcRange(el.dataset.srcOld);
  const anchor = r && anchorFor(file, shows, r[0], r[1]);
  if (!anchor) return null;
  const { side, from, to } = anchorSpan(file, anchor);
  return { key: slotKey(Number(el.dataset.srcId), shows), side, anchor, from, to, label: from === to ? `Comment on line ${from}` : `Comment on lines ${from}–${to}` };
}

/** A box's edges, in px. */
export interface Place { left: number; top: number; right: number; bottom: number }

/**
 * The block whose "+" a pointer at (`x`, `y`) over `pane` shows, `at` the element under it: the
 * innermost block taking a comment whose row band (its top to its bottom, at any x: the gutter
 * left of it, the "+" itself, a list's padding) holds `y`. So the "+" stays while the pointer
 * moves left onto it, and a list's padding beside an item is the item's. Over a review slot (a
 * card), none. `rectOf`: where a block is in the viewport (Diff View passes its measures, kept
 * until the page changes, so a move doesn't measure every block again).
 */
export function hoverBlock(file: CommentableFile, pane: HTMLElement, at: Element | null, x: number, y: number, rectOf: (el: HTMLElement) => Place = (el) => el.getBoundingClientRect()): { el: HTMLElement; target: BlockTarget } | null {
  if (at?.closest('[data-review-slot]')) return null;
  const all = blockElements(pane);
  const rects = new Map<HTMLElement, Place>();
  const rect = (el: HTMLElement) => {
    let r = rects.get(el);
    if (!r) rects.set(el, (r = rectOf(el)));
    return r;
  };
  const inBand = (el: HTMLElement) => { const r = rect(el); return r.top <= y && y < r.bottom; };
  const related = (a: HTMLElement) => (el: HTMLElement) => el === a || el.contains(a) || a.contains(el);
  const start = at?.closest<HTMLElement>('[data-src-id]');
  let pool: HTMLElement[];
  if (start && pane.contains(start)) {
    // Over a block: it, the blocks around it and the ones inside it level with the pointer.
    pool = all.filter((el) => el === start || (related(start)(el) && inBand(el)));
  } else {
    // Beside the blocks (the gutter, the gap to the "+"): the nearest block level with the
    // pointer (a split view's other column is farther), and the blocks around and inside it.
    const band = all.filter(inBand);
    if (band.length === 0) return null;
    const dx = (el: HTMLElement) => { const r = rect(el); return Math.max(0, r.left - x, x - r.right); };
    const near = band.reduce((a, b) => (dx(b) <= dx(a) ? b : a));
    pool = band.filter(related(near));
  }
  // In page order, a block comes before the ones it holds: the innermost first from the end.
  for (const el of pool.reverse()) {
    const target = blockTarget(file, el);
    if (target) return { el, target };
  }
  return null;
}

/** The comment key's block: the innermost one holding the text selection that takes a comment
 * (the selection's block, else the nearest around it that does), else the first one in view that
 * does, the innermost of it and what it holds. */
export function keyboardTarget(file: CommentableFile, pane: HTMLElement): BlockTarget | null {
  const node = window.getSelection()?.anchorNode ?? null;
  const at = node && pane.contains(node) ? (node instanceof Element ? node : node.parentElement) : null;
  if (!at?.closest('[data-review-slot]')) {
    for (let el = at?.closest<HTMLElement>('[data-src-id]'); el && pane.contains(el); el = el.parentElement?.closest<HTMLElement>('[data-src-id]')) {
      const own = blockTarget(file, el);
      if (own) return own;
    }
  }
  const top = pane.getBoundingClientRect().top;
  const els = blockElements(pane);
  const shown = (el: HTMLElement) => el.getBoundingClientRect().bottom >= top;
  for (let i = 0; i < els.length; i++) {
    const outer = els[i]!;
    let best = shown(outer) ? blockTarget(file, outer) : null;
    if (!best) continue;
    // The blocks it holds come next in page order: the innermost one in view that takes a
    // comment, the first of each level.
    let inner = outer;
    for (let j = i + 1; j < els.length && outer.contains(els[j]!); j++) {
      const el = els[j]!;
      if (!inner.contains(el)) break;
      const t = shown(el) ? blockTarget(file, el) : null;
      if (t) { best = t; inner = el; }
    }
    return best;
  }
  return null;
}

/** Lines `from`..`to` of `text` (1-based): Suggest change's text for a block comment. */
export function sourceLines(text: string, from: number, to: number): string {
  return text.split(/\r?\n/).slice(from - 1, to).join('\n');
}
