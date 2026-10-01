import type { RefObject } from 'react';
import { useEffect } from 'react';
import { isDismissKey } from '../ui/HoverTooltip';
import { registerKeys } from '../ui/keyRouter';
import { useFocusTrap } from '../ui/useFocusTrap';

/**
 * A modal dialog (About, the profile dialog) claims every key while it's open, in the key
 * router's `menu` layer (ruling R6, preflight T12): registering there means no lower layer
 * (tooltip/overlay/app) ever sees the key, so no app shortcut (Ctrl+W, Ctrl+Tab, …) acts on the
 * tab behind it while the dialog is up. Claiming only stops propagation to those layers; it
 * doesn't call `preventDefault` for anything but Escape and a wrapping Tab, so typing in the
 * dialog's own fields still works normally, and an ordinary Tab between two fields still moves
 * focus the browser's own way. Escape closes the dialog (WCAG 1.4.13 style dismissal) and
 * doesn't reach the app's own Esc handling (closing a file) behind it.
 *
 * Returns the ref the dialog's own root element (the one with `role="dialog"`) must attach, so
 * `useFocusTrap` (fix round 1: focus trapping + returning focus to the opener) can find its
 * focusable children.
 */
export function useModalKeys<T extends HTMLElement>(open: boolean, close: () => void): RefObject<T | null> {
  const { ref, onTab } = useFocusTrap<T>(open);
  useEffect(() => {
    if (!open) return;
    return registerKeys('menu', (e) => {
      if (isDismissKey(e)) {
        close();
        e.preventDefault();
        return 'handled';
      }
      if (onTab(e)) e.preventDefault();
      return 'handled';
    });
    // `onTab` isn't a dependency: it only closes over `useFocusTrap`'s own stable `ref` object
    // and reads the live DOM through it on each call, so whichever render's copy is registered
    // behaves identically — and re-running this effect every render would thrash the key
    // registration for no benefit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, close]);
  return ref;
}
