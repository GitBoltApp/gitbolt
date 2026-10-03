import { useEffect } from 'react';
import { useStore } from 'zustand';
import { createStore } from 'zustand/vanilla';
import { tabStore, useTabView } from '../app/tabStores';
import type { RepoViewState, RepoViewStore } from '../repo/store';
import type { EditorState } from './model';
import { editState, sessionOf, useRebaseSessions } from './session';

/**
 * UX R2.2: the editor's selected row shows in the details panel (the tab's selection: the view
 * `drivesSelection`, so the graph's comes back when it closes), read-only, to see what a commit
 * holds while planning. The base row shows the base.
 */

const shown = (s: Pick<RepoViewState, 'selection'> | undefined): string | null => (s?.selection.kind === 'commit' ? s.selection.id : null);

/** Shows commit `oid` in tab `tabId`'s details panel (nothing when it isn't in the loaded graph). */
function inspect(tabId: string, oid: string): void {
  const store = tabStore(tabId);
  if (!store || shown(store.getState()) === oid) return;
  store.getState().selectCommitById(oid);
}

/** The row a selection change is about: the one added (a click, an arrow, a Ctrl+click); of a
 * Shift range, its end away from the anchor; after a removal, the one shown if still selected. */
export function focusOf(st: Pick<EditorState, 'rows' | 'selected' | 'anchor'>, before: readonly string[], current: string | null): string | null {
  const added = st.selected.filter((o) => !before.includes(o));
  if (added.length === 1) return added[0];
  if (added.length > 1) {
    const at = (o: string | null) => st.rows.findIndex((r) => r.oid === o);
    const a = at(st.anchor);
    return added.reduce((best, o) => (Math.abs(at(o) - a) > Math.abs(at(best) - a) ? o : best));
  }
  if (current && st.selected.includes(current)) return current;
  return st.selected.at(-1) ?? null;
}

/** Follows the editor's row selection into the details panel while the editor is shown. */
export function useInspectSelection(tabId: string): void {
  useEffect(() => {
    let before = sessionOf(tabId)?.state.selected ?? [];
    return useRebaseSessions.subscribe((x) => {
      const st = x.sessions[tabId]?.state;
      if (!st || st.selected === before) return;
      const prev = before;
      before = st.selected;
      if (st.selected.length === 0 || (st.selected.length === prev.length && st.selected.every((o) => prev.includes(o)))) return;
      const oid = focusOf(st, prev, shown(tabStore(tabId)?.getState()));
      if (oid) inspect(tabId, oid);
    });
  }, [tabId]);
}

/** A click on the base row: no row selected, the base in the details panel. */
export function inspectBase(tabId: string): void {
  const s = sessionOf(tabId);
  if (!s) return;
  editState(tabId, (st) => ({ ...st, selected: [], anchor: null }));
  inspect(tabId, s.state.base.oid);
}

const NO_STORE = createStore(() => ({ selection: { kind: 'none' } })) as unknown as RepoViewStore;

/** Whether the details panel shows the base with no row selected. */
export function useBaseInspected(tabId: string, state: Pick<EditorState, 'selected' | 'base'>): boolean {
  const id = useStore(useTabView(tabId)?.store ?? NO_STORE, shown);
  return state.selected.length === 0 && id === state.base.oid;
}
