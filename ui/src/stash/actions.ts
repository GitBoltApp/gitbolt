import { api } from '../api/client';
import { useRuntime } from '../app/runtime';
import { clearWipDraft, draftMessage, readWipDraft } from '../commit/draft';
import { confirmAction } from '../ui/ConfirmDialog';
import { useToast } from '../ui/toast';
import { runWrite, type WriteCtx } from '../write/client';
import { revealRestored, stashPaths } from './reveal';

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
  // Asked first: a Pop deletes the stash (its commit's list stays readable, but not from the graph).
  const paths = stashPaths(ctx.tabId, oid);
  const out = await runWrite(ctx, (_c, asked) => api.stashApply(ctx.repoId, ctx.worktree, oid, pop, asked.withoutIndex));
  if (out?.status === 'conflicts') {
    useToast.getState().show(`The stash conflicts in ${out.files} ${out.files === 1 ? 'file' : 'files'}; resolve them in Conflicted. The stash is kept.`, { ms: 6000 });
  }
  // What came back (UX round 2): the WIP row, and the first restored file's diff unless it
  // conflicted (the WIP's Conflicted list is where to go then).
  if (out) await revealRestored(ctx.tabId, ctx.worktree, paths, out.status === 'applied');
}

/** A kept stash's Apply (the autostash and recovery banners): the same reveal as Apply/Pop. */
export async function applyKeptStash(ctx: WriteCtx, entry: number, oid: string | null): Promise<void> {
  const paths = stashPaths(ctx.tabId, oid);
  let applied = false;
  await runWrite(ctx, (_, asked) => api.applyKeptStash(ctx.repoId, ctx.worktree, entry, asked.withoutIndex, asked.autostash), { onSuccess: () => { applied = true; } });
  if (applied) await revealRestored(ctx.tabId, ctx.worktree, paths);
}

/** Delete (spec #2 §10): it arms in place first (spec §ui confirms; undoable all the same). */
export async function dropStash(ctx: WriteCtx, oid: string): Promise<void> {
  const name = useRuntime.getState().tabs[ctx.tabId]?.sidebar?.stashes.find((s) => s.id === oid)?.message;
  const arm = name ? `Click again to delete the stash "${name}"` : 'Click again to delete the stash';
  if (!(await confirmAction({ title: 'Delete the stash?', body: 'You can undo this.', confirmLabel: 'Delete', arm, danger: true }))) return;
  await runWrite(ctx, () => api.stashDrop(ctx.repoId, ctx.worktree, oid));
}
