import { api } from '../api/client';
import { useRuntime } from '../app/runtime';
import { promptText } from '../ui/PromptDialog';
import { runWrite, type WriteCtx } from '../write/client';
import { branchNameError } from './branchName';

/** Rename (§9.1): always `git branch -m`, behind the check that `name` is still at `oid` and the
 * new name is free. */
export async function renameBranch(ctx: WriteCtx, name: string, oid: string): Promise<void> {
  const locals = useRuntime.getState().tabs[ctx.tabId]?.sidebar?.locals ?? [];
  const answer = await promptText({
    title: `Rename ${name}`,
    label: 'New name',
    initial: name,
    confirmLabel: 'Rename',
    validate: (v) => (v === name ? 'Type a new name' : branchNameError(v) ?? (locals.some((b) => b.name === v) ? `A branch named ${v} already exists` : null)),
  });
  if (!answer) return;
  const to = answer.value;
  await runWrite(ctx, () => api.renameBranch(ctx.repoId, ctx.worktree, name, to, { head: null, refs: { [`refs/heads/${name}`]: oid, [`refs/heads/${to}`]: null } }));
}
