import { api } from '../api/client';
import type { GbError } from '../api/gen/GbError';
import type { Resolution } from '../api/gen/Resolution';
import type { SubmoduleBehind } from '../api/gen/SubmoduleBehind';
import { shortSha } from '../format/sha';
import { useToast } from '../ui/toast';
import { runWrite, type WriteCtx } from '../write/client';

/** After a submodule side was taken: the submodule is still checked out elsewhere, and a
 * stage-all would stage that commit back (GitBolt never moves it). */
export function submoduleBehindMessage(b: SubmoduleBehind): string {
  return `Submodule ${b.path} is still checked out at ${shortSha(b.head)}: update it to ${shortSha(b.taken)} before committing`;
}

/** One resolution of a conflicted file (spec #2 §13.3): an immediate write. Its answer's WIP
 * lists move the file out of Conflicted; a failure toasts (R12), unless `handle` takes it. `true`
 * once it succeeded. */
export async function resolveFile(ctx: WriteCtx, path: string, resolution: Resolution, base?: string, handle?: (err: GbError) => boolean): Promise<boolean> {
  let done = false;
  await runWrite(ctx, (_, asked) => api.resolveFile(ctx.repoId, ctx.worktree, path, resolution, base, asked.markers, asked.discard), {
    // 2D T20: the merge tool answers a Stale save itself ([Reload from disk] [Overwrite]).
    handle,
    onSuccess: (behind) => {
      done = true;
      if (behind) useToast.getState().show(submoduleBehindMessage(behind), { error: true });
    },
  });
  return done;
}

/** Mark resolved: the file as it is (`git add`); asks first when markers remain. */
export const markResolved = (ctx: WriteCtx, path: string) => resolveFile(ctx, path, { kind: 'asIs' });
