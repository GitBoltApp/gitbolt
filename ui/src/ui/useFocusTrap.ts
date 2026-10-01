import { useEffect, useRef, type RefObject } from 'react';

const FOCUSABLE_SELECTOR = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Every focusable element inside `root`, in DOM (so tab) order. Dialogs (About, the profile
 * form) have no conditionally-hidden-but-tabbable fields, so a plain selector match is enough —
 * unlike `keyRouter.ts`'s `isShown`, this doesn't also need to rule out an off-screen element,
 * which would need a real layout engine to check (jsdom has none; `getClientRects()` is always
 * empty there, which would make this untestable). */
function focusables(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)];
}

export interface FocusTrap<T extends HTMLElement> {
  ref: RefObject<T | null>;
  /** Called from the caller's own keydown handling for a `Tab` press it already owns (see
   * below): wraps focus from the last focusable element back to the first (or the reverse on
   * Shift+Tab), returning true when it moved focus — only then does the caller need to
   * `preventDefault`. An ordinary Tab between two fields inside the trap is left alone, so the
   * browser's own default focus movement handles it. */
  onTab(e: Pick<KeyboardEvent, 'key' | 'shiftKey'>): boolean;
}

/**
 * Traps Tab/Shift+Tab focus inside `ref`'s subtree while `active`: focuses something inside it
 * once (unless something already has focus there, e.g. an `autoFocus` field), and gives focus
 * back to whatever had it before once `active` goes false or the component unmounts.
 *
 * Generic — it doesn't know about the app's key router. A caller that owns every keydown while
 * active (a modal that claims the key router's `menu` layer, ruling R6: `app/modalKeys.ts`'s
 * `useModalKeys`) calls `onTab` from its own handler. A second, independent `keydown` listener
 * added here on the DOM directly would never run: the router's capture-phase claim on `window`
 * already stops the event from reaching anything registered lower, including a listener on this
 * subtree, before the key ever gets here.
 */
export function useFocusTrap<T extends HTMLElement>(active: boolean): FocusTrap<T> {
  const ref = useRef<T | null>(null);
  const returnTo = useRef<HTMLElement | null>(null);
  const wasActive = useRef(false);

  // Captured during render, not in an effect: an `autoFocus` field in the dialog about to mount
  // (About's Close button, the profile form's name field) is applied during React's commit —
  // which runs before any effect, including `useLayoutEffect` — so by the time an effect could
  // read `document.activeElement` here, the dialog's own autoFocus would already have moved it,
  // and this would wrongly "return" focus to the dialog's own field instead of the opener. A
  // render is still running before that commit, so it sees the true, pre-dialog focus. Guarded
  // so it only runs on the render that flips `active` on (a re-render while it's still open
  // mustn't re-capture); mutating a ref in render like this is fine since nothing reads it back
  // to affect this render's own output, only later effects and event handlers.
  if (active && !wasActive.current) {
    returnTo.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  }
  wasActive.current = active;

  useEffect(() => {
    if (!active) return;
    const root = ref.current;
    if (root && !root.contains(document.activeElement)) {
      (focusables(root)[0] ?? root).focus({ preventScroll: true });
    }
    return () => {
      const back = returnTo.current;
      returnTo.current = null;
      if (back?.isConnected) back.focus({ preventScroll: true });
    };
  }, [active]);

  const onTab = (e: Pick<KeyboardEvent, 'key' | 'shiftKey'>): boolean => {
    if (e.key !== 'Tab') return false;
    const root = ref.current;
    if (!root) return false;
    const items = focusables(root);
    if (items.length === 0) return false;
    const first = items[0];
    const last = items[items.length - 1];
    const current = document.activeElement;
    const atEdge = e.shiftKey ? current === first || !root.contains(current) : current === last || !root.contains(current);
    if (!atEdge) return false;
    (e.shiftKey ? last : first).focus({ preventScroll: true });
    return true;
  };

  return { ref, onTab };
}
