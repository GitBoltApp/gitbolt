import { api } from '../api/client';
import { useRuntime } from '../app/runtime';
import { clearWipDraft, draftMessage, readWipDraft } from '../commit/draft';
import { useToast } from '../ui/toast';
import { runWrite, type WriteCtx } from '../write/client';

/** A full stash of `ctx.worktree` (spec #2 §10): the WIP draft is its message (§8.2), cleared
 * after a stash that happened. An empty draft sends '' and the backend names it from the branch.
 * Autostash, apply and pop never touch the draft. */
export async function stashPushFor(ctx: WriteCtx): Promise<void> {
  const repoPath = useRuntime.getState().tabs[ctx.tabId]?.repo?.path ?? '';
  const message = draftMessage(readWipDraft(repoPath, ctx.worktree)).trim();
  const out = await runWrite(ctx, () => api.stashPush(ctx.repoId, ctx.worktree, message));
  if (out?.status === 'nothingToStash') useToast.getState().show('No changes to stash');
  if (out?.status === 'stashed') clearWipDraft(repoPath, ctx.worktree);
}

/** Apply or Pop (spec #2 §10), by the stash's oid. "Apply without restoring what was staged?" is
 * runWrite's question; a refused answer resends with `withoutIndex`. */
export async function applyStash(ctx: WriteCtx, oid: string, pop: boolean): Promise<void> {
  const out = await runWrite(ctx, (_c, asked) => api.stashApply(ctx.repoId, ctx.worktree, oid, pop, asked.withoutIndex));
  if (out?.status === 'conflicts') {
    useToast.getState().show(`The stash conflicts in ${out.files} ${out.files === 1 ? 'file' : 'files'}; resolve them in Conflicted. The stash is kept.`, { ms: 6000 });
  }
}

/** Delete (spec #2 §10): not confirmed, it's undoable. */
export async function dropStash(ctx: WriteCtx, oid: string): Promise<void> {
  await runWrite(ctx, () => api.stashDrop(ctx.repoId, ctx.worktree, oid));
}
