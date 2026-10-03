import type { Origin } from '../ui/arm/origin';
import { confirmAction } from '../ui/ConfirmDialog';
import { EMPTY_DRAFT, readWipDraft, withMergeMessage, writeWipDraft, type WipDraft } from '../commit/draft';

export type Draft = WipDraft;

const ASIDE = 'gitbolt.mergeDraftAside.v1';
const key = (repoPath: string, worktree: string) => `${repoPath}\u0000${worktree}`;
const same = (a: Draft, b: Draft) => a.summary === b.summary && a.description === b.description;

/** §8.2: MERGE_MSG (its `#` lines dropped) goes in the description, below any description there;
 * the summary is kept. An empty summary takes its first line. Nothing typed is ever dropped. */
export function mergeDraft(d: Draft, mergeMsg: string): Draft {
  const text = mergeMsg.replace(/\r\n?/g, '\n').split('\n').filter((l) => !l.startsWith('#')).join('\n');
  return withMergeMessage(d, text);
}

/** Merges being aborted now: the graph may clear their state before Abort's handler runs. */
const aborting = new Set<string>();
export function markAborting(repoPath: string, worktree: string, on: boolean): void {
  if (on) aborting.add(key(repoPath, worktree));
  else aborting.delete(key(repoPath, worktree));
}

/** `head`: the stopped merge; `draft`: the one set aside; `applied`: what the merge wrote. */
interface Aside { head: string; draft: Draft; applied: Draft }
type AsideMap = Record<string, Aside>;
const readAside = (): AsideMap => {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(ASIDE) ?? '{}');
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as AsideMap) : {};
  } catch {
    return {};
  }
};
const writeAside = (a: AsideMap) => {
  try {
    localStorage.setItem(ASIDE, JSON.stringify(a));
  } catch {
    /* per-viewer convenience */
  }
};
const take = (repoPath: string, worktree: string): Aside | null => {
  const aside = readAside();
  const saved = aside[key(repoPath, worktree)];
  if (!saved) return null;
  delete aside[key(repoPath, worktree)];
  writeAside(aside);
  return saved;
};

/** Once per stopped merge (`mergeHead`): sets the draft aside and adds MERGE_MSG to it. It adds,
 * never replaces: what the user typed stays. */
export function applyMergeDraft(repoPath: string, worktree: string, mergeMsg: string, mergeHead: string): void {
  const aside = readAside();
  if (aside[key(repoPath, worktree)]?.head === mergeHead) return;
  const draft = readWipDraft(repoPath, worktree);
  const applied = mergeDraft(draft, mergeMsg);
  aside[key(repoPath, worktree)] = { head: mergeHead, draft, applied };
  writeAside(aside);
  writeWipDraft(repoPath, worktree, applied);
}

/** Abort puts the draft back as it was (§8.2). If the user has since edited the merge message,
 * it asks first, where the Abort started (`origin`; `null`: a popover), never at whatever was
 * clicked last. */
export async function restoreDraftAfterAbort(repoPath: string, worktree: string, origin: Origin | null = null): Promise<void> {
  const saved = take(repoPath, worktree);
  if (!saved) return;
  const cur = readWipDraft(repoPath, worktree);
  if (!same(cur, saved.applied) && !same(cur, EMPTY_DRAFT)) {
    const ok = await confirmAction({ title: 'Restore your earlier message?', body: 'You edited the merge message. Replace it with the commit message you had before the merge?', confirmLabel: 'Restore', arm: 'Click again to restore your earlier message' }, origin);
    if (!ok) return;
  }
  writeWipDraft(repoPath, worktree, saved.draft);
}

/** The merge ended without GitBolt's Abort (a commit, or a terminal): an untouched merge message
 * gives way to the old draft; an edited or sent one stays. */
export function settleDraftAside(repoPath: string, worktree: string): void {
  if (aborting.has(key(repoPath, worktree))) return; // Abort's own handler restores it
  const saved = take(repoPath, worktree);
  if (saved && same(readWipDraft(repoPath, worktree), saved.applied)) writeWipDraft(repoPath, worktree, saved.draft);
}
