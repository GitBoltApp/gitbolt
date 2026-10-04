import { create } from 'zustand';

/** UX round 4 R.2: the WIP's one filter (path substring) over Conflicted, Unstaged and Staged,
 * kept per tab in memory while the WIP is selected. `open`: its row shows under the header. */
export interface WipFilter { open: boolean; text: string }
const CLOSED: WipFilter = { open: false, text: '' };

export const useWipFilter = create<{ byTab: Record<string, WipFilter> }>(() => ({ byTab: {} }));
export const wipFilterOf = (byTab: Record<string, WipFilter>, tabId: string | null | undefined): WipFilter => (tabId ? byTab[tabId] : undefined) ?? CLOSED;
export const setWipFilter = (tabId: string, next: Partial<WipFilter>) =>
  useWipFilter.setState((s) => ({ byTab: { ...s.byTab, [tabId]: { ...wipFilterOf(s.byTab, tabId), ...next } } }));
export const toggleWipFilter = (tabId: string) =>
  useWipFilter.setState((s) => {
    const cur = wipFilterOf(s.byTab, tabId);
    return { byTab: { ...s.byTab, [tabId]: cur.open ? CLOSED : { ...cur, open: true } } };
  });
