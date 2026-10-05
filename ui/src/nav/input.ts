import { runAction } from '../app/actions';
import { registerKeys, type KeyHandler } from '../ui/keyRouter';
import { isEditableTarget } from '../ui/keys';

/** `MouseEvent.button` of the side buttons ("buttons 4/5" on the mouse). */
export const BACK_BUTTON = 3;
export const FORWARD_BUTTON = 4;

const isShown = (el: Element) => el.getClientRects().length > 0;

/**
 * Spec #5 §3.4: Back/Forward don't apply in a text field or a Monaco editor (they use the keys
 * themselves), nor while a menu or a dialog is open. The left flyout (the MR/PR view) is a
 * non-modal panel beside the graph, where Back/Forward matter most: it doesn't count.
 */
export function navSuppressed(target: EventTarget | null): boolean {
  if (isEditableTarget(target)) return true;
  if (target instanceof Element && target.closest('.monaco-editor')) return true;
  return [...document.querySelectorAll('[role="menu"], [role="dialog"]:not([data-flyout])')].some(isShown);
}

const go = (dir: 'back' | 'forward') => runAction(dir === 'back' ? 'nav.back' : 'nav.forward');

/** Alt+← / Alt+→, in the key router's `app` layer: an open menu or modal claims keys first. */
export const navKeys: KeyHandler = (e) => {
  if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight')) return;
  if (navSuppressed(e.target)) return;
  e.preventDefault();
  go(e.key === 'ArrowLeft' ? 'back' : 'forward');
  return 'handled';
};

const isSide = (e: MouseEvent) => e.button === BACK_BUTTON || e.button === FORWARD_BUTTON;
/** The webview's own back/forward on the side buttons is never wanted: always prevented. */
const block = (e: MouseEvent) => {
  if (isSide(e)) e.preventDefault();
};
const onMouseUp = (e: MouseEvent) => {
  if (!isSide(e)) return;
  e.preventDefault();
  if (navSuppressed(e.target)) return;
  go(e.button === BACK_BUTTON ? 'back' : 'forward');
};

/** Installs the side buttons (on the window, capture phase) and Alt+←/→; returns their removal. */
export function installNavInput(): () => void {
  const offKeys = registerKeys('app', navKeys);
  window.addEventListener('mousedown', block, true);
  window.addEventListener('auxclick', block, true);
  window.addEventListener('mouseup', onMouseUp, true);
  return () => {
    offKeys();
    window.removeEventListener('mousedown', block, true);
    window.removeEventListener('auxclick', block, true);
    window.removeEventListener('mouseup', onMouseUp, true);
  };
}
