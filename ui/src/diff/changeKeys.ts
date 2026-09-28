import { useKeys } from '../ui/keyRouter';
import { goToChange } from './DiffToolbar';

/** Where Shift+↑/↓ keep their usual meaning, extending a selection: Monaco (its text area, find
 * widget, …), any other text field, and any editable text (`isContentEditable`: every spelling of
 * `contenteditable`, inherited, but not a `contenteditable="false"` island). */
const OWNS_SHIFT_ARROWS = '.monaco-editor, input, textarea, select, [role="menu"]';
const ownsShiftArrows = (t: Element) => !!t.closest(OWNS_SHIFT_ARROWS) || (t instanceof HTMLElement && t.isContentEditable);

/** The change a key steps to, or null when it isn't one of the change keys (J14): F7 / Shift+F7,
 * and Shift+↓ / Shift+↑ outside the editor and text fields. */
export function changeKeyDirection(e: KeyboardEvent): 'next' | 'previous' | null {
  if (e.ctrlKey || e.altKey || e.metaKey) return null;
  if (e.key === 'F7') return e.shiftKey ? 'previous' : 'next';
  if (!e.shiftKey || (e.key !== 'ArrowDown' && e.key !== 'ArrowUp')) return null;
  if (e.target instanceof Element && ownsShiftArrows(e.target)) return null;
  return e.key === 'ArrowDown' ? 'next' : 'previous';
}

/**
 * The change keys, app-wide (J14), while the diff panel is mounted and `on` (a text diff is
 * shown): whatever has the keyboard (the file list, the graph, the header, the toolbar or the
 * editor). They're app actions in the key router (`ui/keyRouter.ts`), so they're taken before
 * Monaco (whose F7 is its accessible diff viewer, plan 1B deviation 7) or a list sees them, and
 * never while a menu is open: the menu gets them. A hidden panel's effects are gone, so a closed
 * diff takes none.
 */
export function useChangeKeys(on: boolean): void {
  useKeys(
    'app',
    (e) => {
      if (e.defaultPrevented) return;
      const dir = changeKeyDirection(e);
      if (!dir) return;
      e.preventDefault();
      goToChange(dir);
      return 'handled';
    },
    on,
  );
}
