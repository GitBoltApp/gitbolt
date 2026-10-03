import { useMemo } from 'react';
import { useRepoView } from '../repo/store';
import { journalKey, useJournal } from '../undo/store';
import { inProgressOf, operationView, type OperationView } from './inProgress';
import { branchIn, nameAtIn, sidesIn, type ConflictSides } from './sides';

/** The worktree's operation in progress as the commit panel shows it (§13.2), or `null`. */
export function useOperation(repoId: number, worktree: string): OperationView | null {
  const graph = useRepoView((s) => s.graph);
  const paused = useJournal((s) => (worktree ? s.states[journalKey(repoId, worktree)]?.paused ?? null : null));
  return useMemo(() => {
    const p = worktree ? inProgressOf(graph, worktree) : null;
    if (!p) return null;
    const subjectOf = (sha: string) => graph.rows.find((r) => r.id === sha)?.summary ?? null;
    return operationView(p, paused, branchIn(graph, worktree), subjectOf, nameAtIn(graph));
  }, [graph, paused, worktree]);
}

/** The names of the worktree's conflict sides (UX round 2, `conflictSides`), as the merge
 * tool's pane titles name them. */
export function useConflictSides(worktree: string): ConflictSides {
  const graph = useRepoView((s) => s.graph);
  const repoId = useRepoView((s) => s.repo);
  const target = useJournal((s) => s.states[journalKey(repoId, worktree)]?.paused?.target ?? null);
  return useMemo(() => sidesIn(graph, worktree, target), [graph, worktree, target]);
}
