/** One tab's registered sidebar filter focuser (`Sidebar.tsx`), keyed by tab id so the
 * `edit.filterSidebar` action (Ctrl+Alt+F) reaches whichever tab is active. */
const focusers = new Map<string, () => void>();

export function registerSidebarFilter(tabId: string, focus: () => void): () => void {
  focusers.set(tabId, focus);
  return () => { if (focusers.get(tabId) === focus) focusers.delete(tabId); };
}

export function focusSidebarFilter(tabId: string): boolean {
  const f = focusers.get(tabId);
  f?.();
  return !!f;
}
