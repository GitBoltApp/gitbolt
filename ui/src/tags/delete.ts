import { api } from '../api/client';
import { currentOrigin, type Origin } from '../ui/arm/origin';
import { confirmAction } from '../ui/ConfirmDialog';
import { useToast } from '../ui/toast';
import { runWrite, type WriteCtx } from '../write/client';

export interface TagDeletePlan { tag: string; local: boolean; remote: string | null }

/** `Delete | Local | Remote | Both |` (spec #3 §3.9). Local goes at once (Undo brings it back);
 * a remote delete is a push that can't be undone, so the clicked control arms in place first. */
export async function deleteTag(ctx: WriteCtx, plan: TagDeletePlan, origin: Origin | null = currentOrigin()): Promise<void> {
  const { tag, local, remote } = plan;
  if (remote) {
    const ok = await confirmAction({
      title: local ? `Delete ${tag} here and from ${remote}?` : `Delete ${tag} from ${remote}?`,
      body: local ? `Deleting it from ${remote} can't be undone. You can undo deleting the local tag.` : `It goes from ${remote}: this can't be undone.`,
      confirmLabel: 'Delete',
      danger: true,
      arm: local ? `Click again to delete ${tag} here and from ${remote} (the remote delete can't be undone)` : `Click again to delete ${tag} from ${remote} (can't be undone)`,
    }, origin);
    if (!ok) return;
  }
  const done = remote ? (local ? `Deleted ${tag} here and from ${remote}` : `Deleted ${tag} from ${remote}`) : `Deleted tag ${tag}`;
  await runWrite(ctx, () => api.deleteTag(ctx.repoId, ctx.worktree, { name: tag, local, remote }), { origin, onSuccess: () => useToast.getState().show(done) });
}
