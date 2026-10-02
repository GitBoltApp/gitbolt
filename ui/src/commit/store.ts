import { create } from 'zustand';
import type { WipDraft } from './draft';

/**
 * Amend (spec #2 §8.1, §8.2), per WIP draft key: while it's on, the commit box shows and edits
 * HEAD's message (`text`) and the draft is put aside, untouched. Clicking another commit leaves
 * it on, since it lives here, not in the box. Unticking, a successful amend or a HEAD move
 * (`head` no longer the worktree's HEAD) ends it, and the boxes show the draft again.
 */
interface CommitBoxStore {
  amend: Record<string, { text: WipDraft; head: string } | undefined>;
  /** A second start while amending is ignored (§8.2). */
  startAmend(key: string, text: WipDraft, head: string): void;
  setAmendText(key: string, text: WipDraft): void;
  cancelAmend(key: string): void;
}

export const useCommitBox = create<CommitBoxStore>((set) => ({
  amend: {},
  startAmend: (key, text, head) => set((s) => (s.amend[key] ? s : { amend: { ...s.amend, [key]: { text, head } } })),
  setAmendText: (key, text) => set((s) => (s.amend[key] ? { amend: { ...s.amend, [key]: { ...s.amend[key]!, text } } } : s)),
  cancelAmend: (key) => set((s) => ({ amend: { ...s.amend, [key]: undefined } })),
}));
