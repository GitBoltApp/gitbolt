import { tabStore } from '../app/tabStores';
import { closeCenterView } from '../repo/centerView';

/**
 * UX: File History is sticky. While it's open in a tab (the tab store's `stickyHistory`), a file
 * chosen from the right panel opens in File History too (`history/follow.ts`). It ends when File
 * History closes (× / Esc, the sidebar's strip, another view in its place: `feature.ts`'s
 * `onClose`), and when a file is asked for in a view of its own, which this closes it for: the
 * toolbar's File View / Diff View, the file menu's View ▸ Diff / File, an MR/PR note's file, a
 * Markdown link or Back/Forward to a File View place, a file just created.
 */
export function endStickyHistory(tabId: string | null): void {
  if (tabId === null) return;
  const store = tabStore(tabId);
  if (!store?.getState().stickyHistory) return;
  // The open view is File History (the mode never outlives it); closing it clears the mode.
  closeCenterView(tabId);
  store.getState().setStickyHistory(null);
}
