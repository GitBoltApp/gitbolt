import { useEffect } from 'react';
import { api } from '../api/client';
import { selectCommit } from '../app/graphNav';
import { useRuntime, worktreeOf } from '../app/runtime';
import type { TabSlotProps } from '../app/slots';
import { focusCommitBox } from '../commit/CommitBox';
import { useRepoView } from '../repo/store';
import { HoverTooltip } from '../ui/HoverTooltip';
import { journalKey, useJournal } from '../undo/store';
import { runWrite, type WriteCtx } from '../write/client';
import { bannerText, inProgressOf, useIntegrating } from './inProgress';
import { applyMergeDraft, markAborting, restoreDraftAfterAbort, settleDraftAside } from './mergeDraft';
import './conflicts.css';

/** Journal entries already settled (Deviation 4): once per paused entry. */
const settled = new Set<string>();

/** §13.2's banner, in the tab's `banner` slot, while the active worktree is mid-operation and
 * no merge, rebase or pull op of the repo is running (those states are transient). */
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

  if (!ctx || !p || busy) return null;
  const subjectOf = (sha: string) => graph.rows.find((r) => r.id === sha)?.summary ?? null;
  const nameAt = (sha: string) => {
    const row = graph.rows.findIndex((r) => r.id === sha);
    const here = graph.labels.filter((l) => l.row === row && !l.tag);
    const local = here.find((l) => l.local)?.local?.replace(/^refs\/heads\//, '');
    const remote = here.flatMap((l) => l.remotes)[0]?.fullName.replace(/^refs\/remotes\//, '');
    return local ?? remote ?? null;
  };
  const text = bannerText(p, paused, graph.worktrees.find((w) => w.path === ctx.worktree)?.branch ?? null, subjectOf, nameAt);
  const conflicted = 'conflicted' in p ? p.conflicted : 0;
  const blocked = conflicted > 0 ? `Resolve ${conflicted} conflicted ${conflicted === 1 ? 'file' : 'files'} first` : null;
  const control = (action: 'continue' | 'skip' | 'abort') => () => void runWrite(ctx, () => api.rebaseControl(ctx.repoId, ctx.worktree, action));
  const gated = (label: string, run: () => void) => (
    <HoverTooltip content={blocked ?? label}>
      <button type="button" className="primary" aria-disabled={blocked ? true : undefined} onClick={() => !blocked && run()}>{label}</button>
    </HoverTooltip>
  );
  const commit = () => {
    const wip = graph.rows.find((r) => r.wip?.worktreePath === ctx.worktree);
    if (wip) selectCommit(tab.id, wip.id);
    focusCommitBox(tab.id);
  };
  const abortMerge = () => {
    markAborting(repoPath, ctx.worktree, true);
    void runWrite(ctx, () => api.mergeAbort(ctx.repoId, ctx.worktree), { onSuccess: () => restoreDraftAfterAbort(repoPath, ctx.worktree) }).finally(() => markAborting(repoPath, ctx.worktree, false));
  };
  const label = p.kind === 'merge' ? 'Merge in progress' : p.kind === 'rebase' ? 'Rebase in progress' : 'Operation in progress';
  return (
    <section className="conflict-banner" aria-label={label}>
      <span className="conflict-banner-text">{text}</span>
      {p.kind === 'merge' && (
        <>
          {gated('Commit', commit)}
          <button type="button" onClick={abortMerge}>Abort</button>
        </>
      )}
      {p.kind === 'rebase' && (
        <>
          {gated('Continue', control('continue'))}
          <button type="button" onClick={control('skip')}>Skip</button>
          <button type="button" onClick={control('abort')}>Abort</button>
        </>
      )}
    </section>
  );
}
