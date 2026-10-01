import type { MouseEvent } from 'react';

/** Tooltip text shared by every resize handle (K73). */
export const RESIZE_HINT = 'Drag to resize, double-click to reset';

/**
 * Props that make a resize handle reset to its default on double-click (K73). The two pointer
 * presses of the double-click have already run as zero-distance gestures, which commit nothing.
 * Enter on the focused separator does the same, in each handle's own `onKeyDown`.
 */
export function onResetDoubleClick(reset: () => void) {
  return {
    title: RESIZE_HINT,
    onDoubleClick: (e: MouseEvent) => { e.preventDefault(); e.stopPropagation(); reset(); },
  };
}
