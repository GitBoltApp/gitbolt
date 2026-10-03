import { useEffect, type PointerEvent as ReactPointerEvent } from 'react';
import { create } from 'zustand';
import { registerKeys } from '../ui/keyRouter';

/** Pointer travel (px) before a press becomes a drag: less is a click. */
export const DRAG_THRESHOLD = 4;

/**
 * A press that became a drag ends in a click on whatever is under the release (the row there):
 * that click isn't a selection, so the next one is swallowed. It's dropped after this task if no
 * click came (a release off the window).
 */
export function swallowNextClick(): void {
  const kill = (e: MouseEvent) => { e.stopPropagation(); e.preventDefault(); };
  window.addEventListener('click', kill, { capture: true, once: true });
  setTimeout(() => window.removeEventListener('click', kill, { capture: true }), 0);
}

/**
 * A drag cancelled (Esc) while the button is still down: its release would click the row under
 * the pointer, so the click that follows the release is swallowed. A fresh press or a cancel
 * means that release never came here: nothing is swallowed then.
 */
export function swallowReleaseClick(): void {
  const done = () => {
    window.removeEventListener('pointerup', release, true);
    window.removeEventListener('pointerdown', done, true);
    window.removeEventListener('pointercancel', done, true);
  };
  const release = () => { done(); swallowNextClick(); };
  window.addEventListener('pointerup', release, true);
  window.addEventListener('pointerdown', done, true);
  window.addEventListener('pointercancel', done, true);
}

/** The chip being dragged: its branch, the row under the pointer (`over`, an oid), the pointer. */
export interface ChipDrag { branch: string; over: string | null; x: number; y: number }

export const useChipDrag = create<{ drag: ChipDrag | null }>(() => ({ drag: null }));

/** The commit row (`[data-irebase-row]`) under a point: a chip's drop target. */
/** Ends the chip drag under way (its listeners, its Esc), dropping nothing. */
let cancelCurrent: (() => void) | null = null;
export const cancelChipDrag = (): void => cancelCurrent?.();

/** For the editor: a chip drag under way ends with it (unmount). */
export function useChipDragCleanup(): void {
  useEffect(() => () => cancelChipDrag(), []);
}

const rowAt = (x: number, y: number): string | null =>
  (document.elementFromPoint?.(x, y)?.closest('[data-irebase-row]') as HTMLElement | null)?.dataset.oid ?? null;

/**
 * A chip dragged to another row (spec #3 §4.1; UX R1.1). Pointer events, not HTML5 drag and
 * drop: the packaged app's CEF never delivers native drag events for drags inside the page. The
 * press doesn't reach the row (its own drag); past DRAG_THRESHOLD it's a drag, and the release
 * over a commit row drops the branch there. Esc puts it back.
 */
export function startChipDrag(e: ReactPointerEvent<HTMLElement>, branch: string, drop: (branch: string, row: string) => void): void {
  if (e.button !== 0) return;
  e.stopPropagation();
  // No text selection, no native drag, from the press on (UX R1 review).
  e.preventDefault();
  cancelChipDrag();
  const x0 = e.clientX;
  const y0 = e.clientY;
  let active = false;
  const stop = () => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    window.removeEventListener('pointercancel', stop);
    unkey();
    if (cancelCurrent === stop) cancelCurrent = null;
    useChipDrag.setState({ drag: null });
  };
  const move = (ev: PointerEvent) => {
    if (!active && Math.hypot(ev.clientX - x0, ev.clientY - y0) < DRAG_THRESHOLD) return;
    active = true;
    useChipDrag.setState({ drag: { branch, over: rowAt(ev.clientX, ev.clientY), x: ev.clientX, y: ev.clientY } });
  };
  const up = (ev: PointerEvent) => {
    const over = active ? rowAt(ev.clientX, ev.clientY) : null;
    stop();
    if (!active) return;
    swallowNextClick();
    if (over) drop(branch, over);
  };
  // The menu layer, above the editor's own keys (overlay): Esc puts the chip back and nothing else.
  const unkey = registerKeys('menu', (ev) => {
    if (ev.key !== 'Escape' || !active) return;
    ev.preventDefault();
    stop();
    swallowReleaseClick();
    return 'handled';
  });
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
  window.addEventListener('pointercancel', stop);
  cancelCurrent = stop;
}
