import { api } from '../api/client';
import type { ResetMode } from '../api/gen/ResetMode';
import { runWrite, type WriteCtx } from '../write/client';

/** Reset (§9.4). Soft and mixed never confirm; hard asks only when there's something to discard
 * ("Reset main to a1b2c3 and discard changes to N files? You can undo this."): the backend decides
 * under the lock, runWrite asks, then resends with `discard`. A repository in the way is a refusal,
 * shown by the error toast; it is never offered as something to force. */
export async function resetTo(ctx: WriteCtx, sha: string, mode: ResetMode, head: string | null): Promise<void> {
  await runWrite(ctx, (_confirmed, asked) => api.reset(ctx.repoId, ctx.worktree, sha, mode, { head, refs: {} }, asked.discard));
}
