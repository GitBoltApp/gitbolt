export interface Size { w: number; h: number }
const M = 4;

export interface Rect { left: number; right: number; top: number; bottom: number }

/**
 * Top-left for a menu opened at (x, y): flipped left/up when it would leave the viewport. A menu
 * dropped from a button (`anchor`, K70) flips by the button instead: right-aligned to its right
 * edge, or opening upward from its top, so it stays under/over the button rather than mirroring
 * around its left corner.
 */
export function placeMenu(x: number, y: number, menu: Size, vp: Size, anchor?: Rect | null): { left: number; top: number } {
  if (anchor) {
    const left = anchor.left + menu.w + M > vp.w ? Math.max(M, anchor.right - menu.w) : anchor.left;
    const top = anchor.bottom + menu.h + M > vp.h ? Math.max(M, anchor.top - menu.h) : anchor.bottom;
    return { left, top };
  }
  const left = x + menu.w + M > vp.w ? Math.max(M, x - menu.w) : x;
  const top = y + menu.h + M > vp.h ? Math.max(M, y - menu.h) : y;
  return { left, top };
}

/** A submenu beside its row: to the right, else the left; clamped vertically. */
export function placeSubmenu(parent: { left: number; right: number; top: number }, menu: Size, vp: Size): { left: number; top: number } {
  const left = parent.right + menu.w + M > vp.w ? Math.max(M, parent.left - menu.w) : parent.right;
  const top = Math.max(M, Math.min(parent.top, vp.h - menu.h - M));
  return { left, top };
}
