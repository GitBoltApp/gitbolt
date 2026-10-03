import { useEffect } from 'react';
import { api } from '../api/client';
import { useRuntime, worktreeOf } from '../app/runtime';
import type { TabSlotProps } from '../app/slots';
import { useRepoView } from '../repo/store';
import { tabStore } from '../app/tabStores';
import { revealRestored } from '../stash/reveal';
import { journalKey, useJournal } from '../undo/store';
import { runWrite, type WriteCtx } from '../write/client';
import { inProgressOf, operationView, useIntegrating } from './inProgress';
import { applyMergeDraft, settleDraftAside } from './mergeDraft';

/** Journal entries already settled (Deviation 4): once per paused entry. */
const settled = new Set<string>();
/** Stops already shown: the WIP is selected once per stop (ux round 1). */
const shown = new Set<string>();

/**
 * §13.2's watcher, in the tab's `banner` slot, while the active worktree is mid-operation. It
 * draws nothing: the operation's status and its Continue, Skip and Abort live in the commit
 * panel (ux round 1: a window-wide bar pushed the whole interface down). It
 * - once per stop, selects the WIP row (so that panel shows) and opens its first conflicted file;
 * - settles a paused entry whose operation ended outside GitBolt;
 * - adds MERGE_MSG to the WIP draft once per merge (§8.2).
 * It waits while a merge, rebase or pull op of the repo runs (those states are transient).
 */
export function ConflictBanner({ tab }: TabSlotProps) {
  const rt = useRuntime((s) => s.tabs[tab.id]);
  const worktree = worktreeOf(rt);
  const repoId = rt?.repo?.id ?? -1;
  const ctx: WriteCtx | null = worktree && rt?.repo ? { tabId: tab.id, repoId, worktree } : null;
  const repoPath = useRepoView((s) => s.repoPath);
  const graph = useRepoView((s) => s.graph);
  const p = worktree ? inProgressOf(graph, worktree) : null;
  const paused = useJournal((s) => (worktree ? s.states[journalKey(repoId, worktree)]?.paused ?? null : null));
  const busy = useIntegrating(repoId);
  const mergeHead = p?.kind === 'merge' ? p.mergeHead : null;
  const mergeMsg = p?.kind === 'merge' ? p.message : '';
  const none = p === null;
  const stop = p ? operationView(p, null, null, () => null).stop : null;
  const wipId = graph.rows.find((r) => r.wip?.worktreePath === worktree)?.id ?? null;
  const onWip = useRepoView((s) => s.selection?.kind === 'wip' && s.selection.worktree === worktree);

  // Deviation 4: the operation ended outside GitBolt while its journal entry is paused → settle
  // once per entry (it restores the autostash).
  useEffect(() => {
    if (!ctx || busy || !none || !paused) return;
    const id = `${repoId}:${paused.entry}`;
    if (settled.has(id)) return;
    settled.add(id);
    void runWrite(ctx, () => api.settlePaused(ctx.repoId, ctx.worktree)).then((r) => {
      if (r === null) settled.delete(id); // failed: the next render tries again
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repoId, worktree, busy, none, paused]);

  // §8.2: a stopped merge adds MERGE_MSG to the WIP draft, once per merge; a merge that ended
  // some other way gives the old draft back, unless the message was edited or sent.
  useEffect(() => {
    if (!worktree || busy || !rt?.repo) return;
    if (mergeHead) applyMergeDraft(repoPath, worktree, mergeMsg, mergeHead);
    else if (none) settleDraftAside(repoPath, worktree);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repoPath, worktree, busy, mergeHead, none]);

  // A new stop selects the WIP row, whose commit panel holds the operation (ux round 1), and
  // shows its panel (H.1: no file is opened; the user picks one from the Conflicted list).
  useEffect(() => {
    if (!stop || busy || !wipId || !worktree) return;
    const id = `${tab.id}\u0000${worktree}\u0000${stop}`;
    if (shown.has(id)) return;
    shown.add(id);
    // Already there with a file open (a click beat it): leave the user's view alone.
    if (onWip && tabStore(tab.id)?.getState().diff) return;
    void revealRestored(tab.id, worktree, Promise.resolve(null), false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab.id, worktree, stop, busy, wipId]);

  return null;
}
