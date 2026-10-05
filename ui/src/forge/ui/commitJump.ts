import { useMemo } from 'react';
import { useStore } from 'zustand';
import { createStore } from 'zustand/vanilla';
import { selectCommit } from '../../app/graphNav';
import { useTabView } from '../../app/tabStores';
import { recordPlace } from '../../nav/history';
import type { RepoViewStore } from '../../repo/store';

/** BranchFlow's commit rows as links into the graph. */
export interface CommitJump {
  /** The commit is among the graph's loaded rows (else its row isn't clickable). */
  inGraph(sha: string): boolean;
  /** Selects it in the graph, scrolled into view ("Show in graph"), as a navigation place. */
  open(sha: string): void;
}

/** Stands in for a tab with no view store yet: nothing is in its graph. */
const NO_STORE = createStore(() => ({ indexById: new Map<string, number>() })) as unknown as RepoViewStore;

/** Tab `tabId`'s commit jump, following its graph as it reloads. */
export function useCommitJump(tabId: string): CommitJump {
  const index = useStore(useTabView(tabId)?.store ?? NO_STORE, (s) => s.indexById);
  return useMemo(() => ({
    inGraph: (sha) => index.has(sha),
    open: (sha) => {
      if (!index.has(sha)) return;
      // Recorded before the jump, so the view being left saves its scroll (as a SHA link does, 5B).
      recordPlace(tabId, { kind: 'commit', sha });
      selectCommit(tabId, sha, { focus: true });
    },
  }), [tabId, index]);
}
