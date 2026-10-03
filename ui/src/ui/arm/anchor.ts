import { useLayoutEffect, useState, type RefObject } from 'react';

const M = 8;
const GAP = 6;

/** A popover's place: under its anchor, left-aligned with it (above when there's no room below),
 * kept on screen; with no anchor, centred near the top. */
export function placePopover(anchor: { left: number; top: number; bottom: number } | null, size: { w: number; h: number }, vp: { w: number; h: number }): { left: number; top: number } {
  if (!anchor) return { left: Math.max(M, Math.round((vp.w - size.w) / 2)), top: 72 };
  const left = Math.max(M, Math.min(anchor.left, vp.w - size.w - M));
  let top = anchor.bottom + GAP;
  if (top + size.h > vp.h - M && anchor.top - GAP - size.h >= M) top = anchor.top - GAP - size.h;
  return { left, top: Math.max(M, Math.min(top, vp.h - size.h - M)) };
}

/** Places the popover `ref` at `anchor` from its measured size, before paint. */
export function usePopoverPlace(ref: RefObject<HTMLElement | null>, anchor: DOMRect | null): { left: number; top: number } | undefined {
  const [pos, setPos] = useState<{ left: number; top: number }>();
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setPos(placePopover(anchor, { w: r.width, h: r.height }, { w: window.innerWidth, h: window.innerHeight }));
  }, [ref, anchor]);
  return pos;
}
