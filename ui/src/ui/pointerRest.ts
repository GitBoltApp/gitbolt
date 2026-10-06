/**
 * Whether the pointer has rested where it is since the user's last press or key. A trigger that
 * comes under such a pointer (a list re-rendered by the click, a toolbar revealed by an Esc that
 * closed the view over it) gets Chromium's boundary events for the still pointer, as if the
 * pointer had moved onto it; `HoverTooltip` ignores those until the pointer really moves. A
 * tooltip popping up there would otherwise take the next Esc (the key router's `tooltip` layer)
 * meant for the app.
 *
 * Only the user's own input counts (`isTrusted`): a script's synthetic events never park it.
 */
let last: { x: number; y: number } | null = null;
let resting = false;
let counts = (e: Event) => e.isTrusted;

function onMove(e: MouseEvent) {
  if (!counts(e)) return;
  if (last && (e.clientX !== last.x || e.clientY !== last.y)) resting = false;
  last = { x: e.clientX, y: e.clientY };
}
function onPress(e: MouseEvent) {
  if (!counts(e)) return;
  last = { x: e.clientX, y: e.clientY };
  resting = true;
}
function onKey(e: KeyboardEvent) {
  // Where the pointer is unknown (it never crossed the page), there's nothing to rest.
  if (counts(e) && last) resting = true;
}

/** Whether a pointer event now would come from the pointer resting since a press or key. */
export const pointerResting = () => resting;

if (typeof window !== 'undefined') {
  // Capture on the window: ahead of React's listeners on its root, so a trigger's handler sees
  // the move it's handling.
  window.addEventListener('mousemove', onMove, true);
  window.addEventListener('mouseover', onMove, true);
  window.addEventListener('mousedown', onPress, true);
  window.addEventListener('keydown', onKey, true);
  import.meta.hot?.dispose(() => {
    window.removeEventListener('mousemove', onMove, true);
    window.removeEventListener('mouseover', onMove, true);
    window.removeEventListener('mousedown', onPress, true);
    window.removeEventListener('keydown', onKey, true);
  });
}

/** Tests: count jsdom's synthetic events as the user's. The returned function undoes it and
 * forgets the pointer. */
export function countSyntheticPointerEvents(): () => void {
  counts = () => true;
  return () => {
    counts = (e) => e.isTrusted;
    last = null;
    resting = false;
  };
}
