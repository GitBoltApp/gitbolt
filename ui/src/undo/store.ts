import { create } from 'zustand';
import { api } from '../api/client';
import type { AppEvent } from '../api/gen/AppEvent';
import type { JournalState } from '../api/gen/JournalState';

/** One worktree's journal: the backend's canonical worktree path, as the tab's `path`. */
export const journalKey = (repo: number, worktree: string) => `${repo}\u0000${worktree}`;

interface JournalStore {
  states: Record<string, JournalState>;
  set(repo: number, worktree: string, s: JournalState): void;
}

export const useJournal = create<JournalStore>((set) => ({
  states: {},
  set: (repo, worktree, s) => set((st) => ({ states: { ...st.states, [journalKey(repo, worktree)]: s } })),
}));

/** The state at the time a tab shows (events and write results keep it current after). */
export async function loadJournal(repo: number, worktree: string): Promise<void> {
  const key = journalKey(repo, worktree);
  const before = useJournal.getState().states[key];
  try {
    const s = await api.journalState(repo, worktree);
    // A journalChanged (or a write's result) that arrived meanwhile is newer than this response.
    if (useJournal.getState().states[key] === before) useJournal.getState().set(repo, worktree, s);
  } catch (e) {
    console.warn('[gitbolt] journal state', e);
  }
}

/** Feeds `journalChanged` into the store: the app's one lifetime listener (`useGlobalEvents`)
 * calls it, whichever tab shows, so a background tab's Undo is current when it comes back. */
export function applyJournalEvent(ev: AppEvent): void {
  if (ev.type === 'journalChanged') useJournal.getState().set(ev.repo, ev.worktree, ev.state);
}
