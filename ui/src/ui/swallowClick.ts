/**
 * The click that completes a press which just CLOSED a popup must stop there: it must neither
 * reopen the popup (the trigger's own `onClick`) nor act on whatever else is under the pointer.
 * Call it from the popup's outside-press handler (a capture `pointerdown`) when the press was on
 * the popup's trigger; it eats the click of this gesture (matching `hit`) at the window's capture
 * phase. The mark ends with the gesture's `pointerup` (a press dragged off never clicks, so a later
 * keyboard click on the trigger is not swallowed).
 */
export function swallowGestureClick(hit: (e: MouseEvent) => boolean): void {
  const eat = (e: MouseEvent) => {
    if (!hit(e)) return;
    e.stopPropagation();
    e.preventDefault();
    off();
  };
  const end = () => { setTimeout(off, 0); };
  const off = () => {
    window.removeEventListener('click', eat, true);
    window.removeEventListener('pointerup', end, true);
    window.removeEventListener('pointercancel', end, true);
  };
  window.addEventListener('click', eat, true);
  window.addEventListener('pointerup', end, { once: true, capture: true });
  window.addEventListener('pointercancel', end, { once: true, capture: true });
}

/** Whether a pointer event's position is inside `r`. */
export const pointInRect = (e: { clientX: number; clientY: number }, r: { left: number; right: number; top: number; bottom: number }): boolean =>
  e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
