import { api } from '../api/client';
import { shortSha } from '../format/sha';
import { useToast } from '../ui/toast';
import { runWrite, type WriteCtx } from '../write/client';

/**
 * Restore a file from a commit (spec #3 §3.8): `path` as in `sha` into the working tree,
 * unstaged and undoable; `absent` (the commit has no such file) deletes it instead. Over the
 * file's own changes the backend asks, and `runWrite` arms the clicked row in place ("Click again
 * to replace your changes to <path>"); the answer is sent as `confirm`. `true` once it's done.
 */
export async function restoreFile(ctx: WriteCtx, sha: string, path: string, absent: boolean): Promise<boolean> {
  const done = await runWrite(ctx, async (_confirmed, asked) => ({ ...(await api.restoreFile(ctx.repoId, ctx.worktree, sha, path, asked.discard)), outcome: true as const }));
  if (done !== true) return false;
  useToast.getState().show(absent ? `Deleted ${path}` : `Restored ${path} from ${shortSha(sha)}`);
  return true;
}
