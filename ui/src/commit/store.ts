import { create } from 'zustand';
import type { WipDraft } from './draft';

/**
 * Amend (spec #2 §8.1, §8.2), per WIP draft key: while it's on, the commit box shows and edits
 * HEAD's message (`text`) and the draft is put aside, untouched. Clicking another commit leaves
 * it on, since it lives here, not in the box. Unticking, a successful amend or a HEAD move
 * (`head` no longer the worktree's HEAD) ends it, and the boxes show the draft again.
 *
 * `op` (ux round 1): a stopped rebase, cherry-pick or revert shows its own message, prefilled
 * once per stop (`stop`), edited here, and sent with Continue. The draft is put aside likewise.
 */
interface CommitBoxStore {
  amend: Record<string, { text: WipDraft; head: string } | undefined>;
  /** `edited`: the user changed it. Only then does Continue send it; otherwise git keeps its own
   * text (the box's split and `# Conflicts:` drop would rewrite it, review 1). */
  op: Record<string, { text: WipDraft; stop: string; edited: boolean } | undefined>;
  /** A second start while amending is ignored (§8.2). */
  startAmend(key: string, text: WipDraft, head: string): void;
  setAmendText(key: string, text: WipDraft): void;
  cancelAmend(key: string): void;
  /** Ignored when this stop's message is already there (it may have been edited). */
  startOp(key: string, text: WipDraft, stop: string): void;
  setOpText(key: string, text: WipDraft): void;
  clearOp(key: string): void;
}

export const useCommitBox = create<CommitBoxStore>((set) => ({
  amend: {},
  op: {},
  startAmend: (key, text, head) => set((s) => (s.amend[key] ? s : { amend: { ...s.amend, [key]: { text, head } } })),
  setAmendText: (key, text) => set((s) => (s.amend[key] ? { amend: { ...s.amend, [key]: { ...s.amend[key]!, text } } } : s)),
  cancelAmend: (key) => set((s) => ({ amend: { ...s.amend, [key]: undefined } })),
  startOp: (key, text, stop) => set((s) => (s.op[key]?.stop === stop ? s : { op: { ...s.op, [key]: { text, stop, edited: false } } })),
  setOpText: (key, text) => set((s) => (s.op[key] ? { op: { ...s.op, [key]: { ...s.op[key]!, text, edited: true } } } : s)),
  clearOp: (key) => set((s) => ({ op: { ...s.op, [key]: undefined } })),
}));
