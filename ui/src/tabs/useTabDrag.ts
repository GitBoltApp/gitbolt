import { useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react';
import { flushSync } from 'react-dom';

/** The tabs' layout boxes when the drag started (client px, untransformed). */
export interface StripGeometry {
  lefts: number[];
  widths: number[];
  /** The strip's own client box: the dragged tab never leaves it. */
  stripLeft: number;
  stripRight: number;
}

/** The dragged tab's offset for a pointer offset `dx`, clamped so the tab stays over the tabs
 * themselves and inside the strip. */
export function clampDx(g: StripGeometry, from: number, dx: number): number {
  const n = g.lefts.length;
  const lo = Math.max(g.stripLeft, g.lefts[0]) - g.lefts[from];
  const hi = Math.min(g.stripRight, g.lefts[n - 1] + g.widths[n - 1]) - (g.lefts[from] + g.widths[from]);
  return Math.min(Math.max(dx, Math.min(lo, 0)), Math.max(hi, 0));
}

/** The target index for the dragged tab at offset `dx`, from the tab midpoints (widths vary): it
 * passes a neighbour once its leading edge crosses that neighbour's midpoint. (Its leading edge,
 * not its centre: clamped at the end of the strip, a wide tab's centre never reaches a narrow last
 * tab's midpoint.) */
export function targetIndex(g: StripGeometry, from: number, dx: number): number {
  const mids = g.lefts.map((l, i) => l + g.widths[i] / 2);
  if (dx > 0) {
    const edge = g.lefts[from] + g.widths[from] + dx;
    return from + mids.filter((m, i) => i > from && m < edge).length;
  }
  const edge = g.lefts[from] + dx;
  return from - mids.filter((m, i) => i < from && m > edge).length;
}

/** How far each tab moves to show the order a release at `to` would produce: the tabs between
 * the two slots slide by the dragged tab's width, leaving its landing slot empty. The dragged
 * tab's own entry is the offset of that slot (where a release animates it to). */
export function shifts(widths: number[], from: number, to: number): number[] {
  const w = widths[from];
  return widths.map((_, i) => {
    if (i === from) {
      if (to > from) return widths.slice(from + 1, to + 1).reduce((a, b) => a + b, 0);
      if (to < from) return -widths.slice(to, from).reduce((a, b) => a + b, 0);
      return 0;
    }
    if (to > from && i > from && i <= to) return -w;
    if (to < from && i >= to && i < from) return w;
    return 0;
  });
}

const THRESHOLD = 4;
/** Matches `.tabs.reordering .tab`'s transition in tabs.css. */
export const SLIDE_MS = 150;

type Phase = 'drag' | 'settle';
interface Drag { from: number; to: number; dx: number; phase: Phase; widths: number[] }

const reducedMotion = () => typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/**
 * Pointer-driven tab reordering (spec §6.2, no DnD library). Past a 4 px threshold the pressed
 * tab follows the pointer and the others slide aside to show where a release puts it. A release
 * slides it into that slot and then commits the move; Esc slides everything back.
 */
export function useTabDrag(onMove: (from: number, to: number) => void) {
  const [drag, setDrag] = useState<Drag | null>(null);
  const justDragged = useRef(false);
  const settling = useRef(false);
  const cleanup = useRef<(() => void) | null>(null);
  useEffect(() => () => cleanup.current?.(), []);

  /** The click a release dispatches (if it lands on the tab) comes in the same task; past that,
   * clicks count again. */
  const swallowClick = () => {
    justDragged.current = true;
    window.setTimeout(() => { justDragged.current = false; }, 0);
  };

  const onPointerDown = (e: ReactPointerEvent<HTMLElement>, index: number) => {
    if (e.button !== 0 || settling.current) return;
    const strip = e.currentTarget.parentElement;
    if (!strip) return;
    const rects = [...strip.querySelectorAll<HTMLElement>('[role="tab"]')].map((el) => el.getBoundingClientRect());
    const sr = strip.getBoundingClientRect();
    const g: StripGeometry = { lefts: rects.map((r) => r.left), widths: rects.map((r) => r.width), stripLeft: sr.left, stripRight: sr.right };
    const x0 = e.clientX;
    let active = false;
    let last = { to: index, dx: 0 };

    const stop = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', cancel);
      window.removeEventListener('keydown', key, true);
      cleanup.current = null;
    };
    /** Animate to the final state, then (after the slide) commit and drop the transforms in one
     * render, so the tab is already where the new order puts it: no jump. */
    const settle = (to: number) => {
      stop();
      settling.current = true;
      setDrag({ from: index, to, dx: 0, phase: 'settle', widths: g.widths });
      const finish = () => {
        settling.current = false;
        cleanup.current = null;
        // One render for the new order and the dropped transforms (a store update and a state
        // update from a timer could otherwise land in separate renders: a one-frame flash).
        flushSync(() => {
          if (to !== index) onMove(index, to);
          setDrag(null);
        });
      };
      if (reducedMotion()) return finish();
      const timer = window.setTimeout(finish, SLIDE_MS);
      cleanup.current = () => window.clearTimeout(timer); // unmounted mid-slide: drop the move
    };
    const move = (ev: PointerEvent) => {
      const raw = ev.clientX - x0;
      if (!active && Math.abs(raw) < THRESHOLD) return;
      active = true;
      const dx = clampDx(g, index, raw);
      last = { to: targetIndex(g, index, dx), dx };
      setDrag({ from: index, ...last, phase: 'drag', widths: g.widths });
    };
    const up = () => {
      if (!active) return stop();
      swallowClick();
      settle(last.to);
    };
    const cancel = () => {
      if (!active) return stop();
      settle(index);
    };
    const key = (ev: KeyboardEvent) => {
      if (ev.key !== 'Escape' || !active) return;
      ev.preventDefault();
      ev.stopPropagation();
      settle(index);
      // The release that follows mustn't click the tab either.
      window.addEventListener('pointerup', swallowClick, { once: true });
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', cancel);
    window.addEventListener('keydown', key, true);
    cleanup.current = stop;
  };

  /** True once right after a drag ends: the click that follows must not activate the tab. */
  const consumeClick = () => {
    const was = justDragged.current;
    justDragged.current = false;
    return was;
  };

  /** The transform for tab `i` during a drag (undefined when nothing moves it). */
  const tabStyle = (i: number): CSSProperties | undefined => {
    if (!drag) return undefined;
    const s = shifts(drag.widths, drag.from, drag.to);
    const x = i === drag.from && drag.phase === 'drag' ? drag.dx : s[i];
    return x ? { transform: `translateX(${x}px)` } : undefined;
  };

  return { drag, onPointerDown, consumeClick, tabStyle };
}
