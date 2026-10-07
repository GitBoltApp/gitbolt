/** A horizontal span, in window pixels. */
export interface Span { left: number; right: number }

/**
 * Which way an armed control's label grows, and how wide it may get: toward the side of its
 * container (`bounds`) with room for the label (`needed`, its natural width), the `preferred`
 * side (`data-arm-grow`) first when it has room. With room on neither side, the roomier one, the
 * label clipped there: it never crosses the container's edge. Growing left keeps the control's
 * right edge; growing right, its left edge.
 */
export function armPlacement(control: Span, bounds: Span, needed: number, preferred: 'left' | 'right' | null): { grow: 'left' | 'right'; maxWidth: number } {
  const room = { left: control.right - bounds.left, right: bounds.right - control.left };
  const roomier = room.right >= room.left ? 'right' : 'left';
  const first = preferred ?? roomier;
  const other = first === 'left' ? 'right' : 'left';
  const grow = needed <= room[first] ? first : needed <= room[other] ? other : roomier;
  return { grow, maxWidth: Math.max(control.right - control.left, room[grow]) };
}

/** The box an armed label stays inside: the control's nearest scroll container (a panel's body,
 * a list) or `[data-arm-bounds]`, else the window (less an 8px margin). A box that only clips
 * (`overflow: hidden`, a button group) doesn't count: the overlay is drawn over it. */
export function armBounds(el: HTMLElement): Span {
  const win = { left: 8, right: window.innerWidth - 8 };
  for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
    const s = getComputedStyle(p);
    const clips = p.hasAttribute('data-arm-bounds') || /auto|scroll/.test(`${s.overflowX} ${s.overflowY}`);
    if (!clips) continue;
    const r = p.getBoundingClientRect();
    if (r.width === 0) continue;
    return { left: Math.max(win.left, r.left), right: Math.min(win.right, r.right) };
  }
  return win;
}
