import { useEffect, useLayoutEffect, useRef, type RefObject } from 'react';

/** A wheel "line" in px (deltaMode 1: Firefox, some Linux mice): Chromium's own line step. */
export const WHEEL_LINE_PX = 40;

/**
 * How far a wheel event scrolls the tab strip, in px (positive: right). The strip only scrolls
 * sideways, so a vertical wheel turns it (down: right, up: left) and a horizontal one (a thumb
 * wheel, a trackpad, Shift+wheel) passes through: whichever axis the event moves most along.
 * Lines and pages (`deltaMode` 1 and 2) are converted, a page being the strip's visible width.
 */
export function wheelDelta(e: Pick<WheelEvent, 'deltaX' | 'deltaY' | 'deltaMode'>, page: number): number {
  const d = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
  return e.deltaMode === 1 ? d * WHEEL_LINE_PX : e.deltaMode === 2 ? d * page : d;
}

const reducedMotion = () => typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/** Share of the remaining distance a glide covers each frame: a notch settles in about 4 frames. */
const GLIDE = 0.45;

/** The active tab's box, scrolled into view along the strip only (no page or panel moves). */
function revealActive(strip: HTMLElement, active: string) {
  const el = strip.querySelector<HTMLElement>(`.tab[data-tab-id="${CSS.escape(active)}"]`);
  el?.scrollIntoView?.({ inline: 'nearest', block: 'nearest' });
}

/**
 * The tab strip scrolls sideways under the wheel (no scrollbar: tabs.css), gliding to a target the
 * notches add up on, so a fast spin never queues up behind an animation; and the active tab is
 * scrolled into view whenever it changes, by whatever route (a click, Ctrl+Tab, Ctrl+1..9, a new
 * or reopened tab, a close activating a neighbour, launch), or a group expands. A tab growing in
 * (the active one out of a collapsed group, or the tabs of a group expanding) is followed to the
 * end of its slide, until the wheel takes over.
 */
export function useStripScroll(strip: RefObject<HTMLElement | null>, active: string | null, expanded: string, dragging: boolean) {
  const draggingRef = useRef(dragging);
  draggingRef.current = dragging;
  /** Re-reveal the active tab as the strip's widths settle: on since the last activation, off
   * once the wheel scrolls the strip. */
  const follow = useRef(false);
  const activeRef = useRef(active);
  activeRef.current = active;

  useEffect(() => {
    const el = strip.current;
    if (!el) return;
    let target = el.scrollLeft;
    let frame = 0;
    const glide = () => {
      const before = el.scrollLeft;
      const d = target - before;
      // The last stretch in one go: scrollLeft snaps to device pixels, so sub-pixel steps stall.
      if (Math.abs(d) < 2) {
        el.scrollLeft = target;
        frame = 0;
        return;
      }
      el.scrollLeft = before + Math.sign(d) * Math.max(1, Math.abs(d) * GLIDE);
      // Stuck (an edge the target overshot after a resize): stop rather than spin.
      frame = el.scrollLeft === before ? 0 : requestAnimationFrame(glide);
    };
    const onWheel = (e: WheelEvent) => {
      const max = el.scrollWidth - el.clientWidth;
      if (max <= 0 || e.ctrlKey) return; // nothing to scroll; Ctrl+wheel is the page's zoom
      e.preventDefault();
      // A drag measures the strip once, at its start: it doesn't move under one.
      if (draggingRef.current) return;
      follow.current = false;
      const from = frame ? target : el.scrollLeft;
      target = Math.min(max, Math.max(0, from + wheelDelta(e, el.clientWidth)));
      if (reducedMotion() || typeof requestAnimationFrame !== 'function') {
        el.scrollLeft = target;
        return;
      }
      if (!frame) frame = requestAnimationFrame(glide);
    };
    const onSettled = (e: TransitionEvent) => {
      if (e.propertyName === 'width' && follow.current && activeRef.current && !frame) revealActive(el, activeRef.current);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    el.addEventListener('transitionend', onSettled);
    return () => {
      cancelAnimationFrame(frame);
      el.removeEventListener('wheel', onWheel);
      el.removeEventListener('transitionend', onSettled);
    };
  }, [strip]);

  // After the DOM has the new active tab (a new tab's element exists, a collapsed one is shown).
  useLayoutEffect(() => {
    const el = strip.current;
    if (!el || !active) return;
    follow.current = true;
    revealActive(el, active);
  }, [strip, active, expanded]);
}
