import type { ThemeDef } from '../theme/themes';
import { editorColors } from './monaco/theme';

/**
 * The rendered Markdown diff's overview ruler: pure geometry and colours, after Monaco's diff
 * overview (`OverviewRulerFeature`: two 15 px lanes, the viewport slider as `ScrollbarState`
 * computes it) so the strip looks and moves like the Source diff's. `MdDiffRuler` draws it.
 */

/** Monaco's `ENTIRE_DIFF_OVERVIEW_WIDTH` and `ONE_OVERVIEW_WIDTH`. */
export const RULER_WIDTH = 30;
export const LANE_WIDTH = 15;
/** A change this short still shows. */
export const MIN_MARK_PX = 2;
/** Monaco's `MINIMUM_SLIDER_SIZE`. */
export const MIN_SLIDER_PX = 20;
/** One wheel "line" (deltaMode 1), in px. */
const WHEEL_LINE_PX = 16;

export type RulerKind = 'added' | 'removed' | 'changed';

/** A change in the pane: its offset and height in the scroll content. */
export interface RulerMark { top: number; height: number; kind: RulerKind }
export interface MarkRect { x: number; y: number; w: number; h: number; kind: RulerKind }

/** A change element's `data-diff-mark` as a ruler kind: a diagram pair is one change. */
export function markKind(mark: string | null | undefined): RulerKind | null {
  if (mark === 'added' || mark === 'removed' || mark === 'changed') return mark;
  return mark === 'pair' ? 'changed' : null;
}

/** Each mark on a `stripHeight` strip over `contentHeight` px of content (the pane's
 * scrollHeight), as Monaco's overview zones: at least MIN_MARK_PX, centred on the change and
 * kept inside the strip. `split`: removed on the left lane, added on the right, changed across. */
export function markRects(marks: readonly RulerMark[], contentHeight: number, stripHeight: number, split: boolean): MarkRect[] {
  if (contentHeight <= 0 || stripHeight <= 0) return [];
  const ratio = stripHeight / contentHeight;
  const half = MIN_MARK_PX / 2;
  return marks.map(({ top, height, kind }) => {
    const y1 = Math.floor(top * ratio);
    const y2 = Math.floor((top + height) * ratio);
    let centre = (y1 + y2) / 2;
    const h = Math.max(half, y2 - centre);
    centre = Math.min(Math.max(centre, h), stripHeight - h);
    const lane = !split || kind === 'changed' ? [0, RULER_WIDTH] : kind === 'removed' ? [0, LANE_WIDTH] : [LANE_WIDTH, LANE_WIDTH];
    return { x: lane[0]!, y: centre - h, w: lane[1]!, h: 2 * h, kind };
  });
}

export interface Slider { needed: boolean; top: number; height: number; ratio: number }

/** The viewport slider of a `visible` px view on `content` px at `scrollTop`, on a `strip` px
 * strip (Monaco's `ScrollbarState`, no arrows): proportional, at least MIN_SLIDER_PX. */
export function sliderOf(visible: number, content: number, scrollTop: number, strip: number): Slider {
  if (!(content > visible) || content <= 0) return { needed: false, top: 0, height: Math.round(strip), ratio: 0 };
  const height = Math.round(Math.max(MIN_SLIDER_PX, Math.floor((visible * strip) / content)));
  const ratio = (strip - height) / (content - visible);
  return { needed: true, top: Math.round(scrollTop * ratio), height, ratio };
}

const clampTop = (top: number, visible: number, content: number) => Math.min(Math.max(0, top), Math.max(0, content - visible));

/** The scrollTop that centres the slider on `y` (a click on the strip, as Monaco's scrollbar). */
export function scrollTopAt(y: number, visible: number, content: number, strip: number): number {
  const s = sliderOf(visible, content, 0, strip);
  if (!s.needed || s.ratio <= 0) return 0;
  return clampTop((y - s.height / 2) / s.ratio, visible, content);
}

/** The scrollTop after dragging the slider `dy` px from where the view was at `startTop`. */
export function dragScrollTop(startTop: number, dy: number, visible: number, content: number, strip: number): number {
  const s = sliderOf(visible, content, startTop, strip);
  if (!s.needed || s.ratio <= 0) return 0;
  return clampTop(startTop + dy / s.ratio, visible, content);
}

/** A wheel event's vertical delta in px (`page`: the view's height, for deltaMode 2). */
export function wheelPixels(e: { deltaY: number; deltaMode: number }, page: number): number {
  return e.deltaMode === 1 ? e.deltaY * WHEEL_LINE_PX : e.deltaMode === 2 ? e.deltaY * page : e.deltaY;
}

export interface RulerColors { added: string; removed: string; changed: string }

/** The strip's colours in `def`: added and removed are the Source diff's overview colours; a
 * changed block (words, code lines, a note-only change) is the theme's modified tone at the same
 * alpha. There is no ground: Monaco's `.diffOverview` shade rules (`.vs`/`.vs-dark`) never match the
 * app's custom theme, so its strip is transparent over the editor background (measured). */
export function rulerColors(def: ThemeDef): RulerColors {
  const ed = editorColors(def);
  const added = ed['diffEditorOverview.insertedForeground']!;
  return {
    added,
    removed: ed['diffEditorOverview.removedForeground']!,
    changed: `${def.colors['status-modified'].toLowerCase().slice(0, 7)}${added.slice(7)}`,
  };
}
