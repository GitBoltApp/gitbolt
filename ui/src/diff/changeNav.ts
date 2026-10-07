/**
 * Next / Previous change by where the view is (VS Code's rule, by the scroll rather than the
 * cursor), shared by the diff editor and the rendered Markdown diff. Positions are px in the
 * view's scroll space.
 */

/** A change's extent: the top of its first line (either side) to the bottom of its last. */
export interface ChangeBox { top: number; bottom: number }
/** A scrolled view: its scroll position and height. */
export interface ScrollView { top: number; height: number }
export type StepDir = 'next' | 'previous';

/** Sub-pixel layout rounding: a change centred by a reveal is never taken for one past the centre. */
const SLACK = 2;

/**
 * The change Next or Previous goes to from `view`: Next, the first change starting below the
 * view's centre line; Previous, the last one ending above it. So a change across the centre (the
 * one a step just centred) is the current one, and either step leaves it. Past the last change
 * Next wraps to the first, and Previous before the first to the last.
 *
 * `current`: the change a reveal put the view on, while the view is still there (the open, or the
 * last step). The steps go from it instead, one by one, where the view couldn't centre it (on the
 * first screen, or at the end). `boxes` are in order, top to bottom; null when there are none.
 */
export function stepTarget(boxes: ChangeBox[], view: ScrollView, dir: StepDir, current: number | null = null): number | null {
  const n = boxes.length;
  if (n === 0) return null;
  if (current !== null && current >= 0 && current < n) return dir === 'next' ? (current + 1) % n : (current - 1 + n) % n;
  const centre = view.top + view.height / 2;
  if (dir === 'next') {
    const i = boxes.findIndex((b) => b.top > centre + SLACK);
    return i < 0 ? 0 : i;
  }
  const i = boxes.findLastIndex((b) => b.bottom < centre - SLACK);
  return i < 0 ? n - 1 : i;
}

/** The scroll position that centres `box` in a view `height` tall. A change taller than the view
 * (less `margin` above and below) starts `margin` below its top instead. Never above the content. */
export function revealTop(box: ChangeBox, height: number, margin: number): number {
  const top = box.bottom - box.top > height - 2 * margin ? box.top - margin : (box.top + box.bottom) / 2 - height / 2;
  return Math.max(0, top);
}

/** Where a file opens: at the top when its first change shows there whole, else that change
 * revealed (`revealTop`). */
export function openTop(first: ChangeBox, height: number, margin: number): number {
  return first.bottom <= height ? 0 : revealTop(first, height, margin);
}
