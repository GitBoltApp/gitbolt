import { api } from '../api/client';
import { showServerResult } from '../sync/serverOutput';
import { runWrite, type WriteCtx } from '../write/client';

/** Push one tag, or every tag (`tag` null), to `remote` (spec #3 §3.9), with the server's output
 * as a push's (spec #2 §12.4). */
export async function pushTags(ctx: WriteCtx, remote: string, tag: string | null): Promise<void> {
  await runWrite(ctx, () => api.pushTags(ctx.repoId, ctx.worktree, remote, tag), {
    onSuccess: (o) => {
      const done = o.upToDate ? (tag ? `${remote} already has ${tag}` : `${remote} already has every tag`) : tag ? `Pushed ${tag} to ${remote}` : `Pushed all tags to ${remote}`;
      showServerResult(done, `${done}; the server reported a problem`, o.server, o.op);
    },
  });
}
