import type { RefLabel } from '../api/gen/RefLabel';

/** The chip's fixed horizontal parts (graph.css `.ref-label`): 5 px padding each side, 3 px
 * between its items. The head check is ~0.76 chip-heights, the other icons 12-14 px. */
export const CHIP_PAD = 10;
export const CHIP_GAP = 3;
/** The space between two chips (and before `+N`: graph.css `.ref-more` margin-left). */
export const CHIP_SPACING = 4;
/** `.ref-connector`'s floor: the line to the canvas always keeps this much (graph.css). */
export const CONNECTOR_MIN = 8;
const ICON = 14;
const HEAD_CHECK = 16;
/** The upstream-name warning (UX round 3, M.1: UpstreamWarning.tsx), at the chip's 12 px. */
const WARN = 12;

const widthCache = new Map<string, number>();

/** The chips' font, read once (a `getComputedStyle` per row render would force style recalcs while
 * scrolling) and again after a resize, which a zoom change also fires. */
let fontCache: string | null = null;
if (typeof window !== 'undefined') window.addEventListener('resize', () => { fontCache = null; });
export function chipFont(): string {
  if (fontCache === null) fontCache = typeof document !== 'undefined' && document.body ? getComputedStyle(document.body).font : '12px sans-serif';
  return fontCache || '12px sans-serif';
}
let ctx: CanvasRenderingContext2D | null | undefined;

/** A name's rendered width at `font`, cached per (font, name). A canvas measureText: no layout, so
 * fitting a row costs no reflow. Without a canvas (jsdom) it's a per-character estimate. */
export function textWidth(name: string, font: string): number {
  const key = `${font}|${name}`;
  const hit = widthCache.get(key);
  if (hit !== undefined) return hit;
  if (ctx === undefined) {
    try { ctx = typeof document === 'undefined' ? null : document.createElement('canvas').getContext('2d'); } catch { ctx = null; }
  }
  let w = name.length * 6.5;
  if (ctx) {
    ctx.font = font;
    const m = ctx.measureText(name).width;
    if (m > 0) w = m;
  }
  if (widthCache.size > 5000) widthCache.clear();
  widthCache.set(key, w);
  return w;
}

/** A chip's estimated width: padding, the name, and its icons with the gaps between them.
 * `iconOnly`: the chip shows no name (the compact column, a crowded detached HEAD). */
export function chipWidth(label: RefLabel, font: string, iconOnly = false): number {
  const warn = label.upstreamMismatch ? 1 : 0;
  const icons = warn + (label.isHead ? 1 : 0) + (label.tag ? 1 : 0) + (label.local ? 1 : 0) + label.remotes.length + (label.worktree ? 1 : 0);
  const iconW = warn * WARN + (label.isHead ? HEAD_CHECK : 0) + (label.tag ? 12 : 0) + (label.local ? ICON : 0) + label.remotes.length * ICON + (label.worktree ? ICON : 0);
  if (iconOnly) return CHIP_PAD + iconW + Math.max(0, icons - 1) * CHIP_GAP;
  return CHIP_PAD + textWidth(label.name, font) + iconW + icons * CHIP_GAP;
}

/** The rebasing chip's estimated width (RefLabels.tsx RebasingChip): the spinner, the name and
 * the dashed border. */
export function rebasingWidth(name: string, font: string): number {
  return CHIP_PAD + 12 + CHIP_GAP + textWidth(name, font) + 2;
}

/** The `+N` badge's width for `hidden` labels (its text at 11 px, 4 px padding each side). */
export function moreWidth(hidden: number): number {
  return CHIP_SPACING + 8 + String(hidden).length * 6.5 + 6.5;
}

/**
 * How many of a row's chips (in order, the checked-out branch first) are shown whole in `avail`
 * px (the Branch/Tag column's width), the rest collapsing into `+N`. All of them when they fit
 * together with the connector's floor; otherwise as many as fit beside the `+N` badge. Always at
 * least one: the first chip ellipsizes rather than vanishing. `compact` (the column at its
 * minimum) shows just the first.
 */
export function fitCount(widths: readonly number[], avail: number, compact = false): number {
  const n = widths.length;
  if (n <= 1 || compact) return Math.min(n, 1);
  const room = avail - CONNECTOR_MIN;
  let sum = 0;
  const cum: number[] = [];
  for (let i = 0; i < n; i++) { sum += widths[i] + (i > 0 ? CHIP_SPACING : 0); cum.push(sum); }
  if (sum <= room) return n;
  for (let k = n - 1; k >= 2; k--) if (cum[k - 1] + moreWidth(n - k) <= room) return k;
  return 1;
}
