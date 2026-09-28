export interface Size { w: number; h: number }
const M = 4;

/** Top-left for a menu opened at (x, y): flipped left/up when it would leave the viewport. */
export function placeMenu(x: number, y: number, menu: Size, vp: Size): { left: number; top: number } {
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
