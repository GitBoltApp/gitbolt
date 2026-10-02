import type { RefLabel } from '../api/gen/RefLabel';
import type { RowPayload } from '../api/gen/RowPayload';
import type { RepoViewStore } from '../repo/store';

/**
 * Double-clicks in the graph (spec #2 §9.3: a branch chip checks it out; §11.2: another
 * worktree's WIP row becomes the active one), registered by the features that own them so the
 * graph knows none of them (ruling R10). The first handler that returns `true` took it.
 */
export interface GraphDoubleClick {
  label?: (store: RepoViewStore, row: RowPayload, label: RefLabel) => boolean;
  row?: (store: RepoViewStore, row: RowPayload) => boolean;
}

const handlers = new Set<GraphDoubleClick>();

export function registerGraphDoubleClick(h: GraphDoubleClick): () => void {
  handlers.add(h);
  return () => { handlers.delete(h); };
}

export function graphLabelDoubleClick(store: RepoViewStore, row: RowPayload, label: RefLabel): boolean {
  for (const h of handlers) if (h.label?.(store, row, label)) return true;
  return false;
}

export function graphRowDoubleClick(store: RepoViewStore, row: RowPayload): boolean {
  for (const h of handlers) if (h.row?.(store, row)) return true;
  return false;
}
