import { create } from 'zustand';
import type { StagingUndoState } from '../api/gen/StagingUndoState';

/** One worktree of one open repo. */
export const stagingKey = (repo: number, worktree: string) => `${repo}\u0000${worktree}`;

export const COMMIT_QUEUED = 'Commit queued';

interface StagingStore {
  /** The staging undo log's state (spec #2 §7.6), from every write's answer (`applyResult`). */
  states: Record<string, StagingUndoState>;
  /** A commit for the worktree is queued or running: staging and discards wait (§3.6). */
  committing: Record<string, boolean>;
  set(repo: number, worktree: string, s: StagingUndoState): void;
  setCommitting(repo: number, worktree: string, on: boolean): void;
}

export const useStaging = create<StagingStore>((set) => ({
  states: {},
  committing: {},
  set: (repo, worktree, s) => set((st) => ({ states: { ...st.states, [stagingKey(repo, worktree)]: s } })),
  setCommitting: (repo, worktree, on) => set((st) => ({ committing: { ...st.committing, [stagingKey(repo, worktree)]: on } })),
}));

export const useCommitting = (repo: number, worktree: string) => useStaging((s) => !!s.committing[stagingKey(repo, worktree)]);
