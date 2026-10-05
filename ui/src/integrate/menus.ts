import { registerMenu } from '../menu/registry';
import type { CommitTarget, MenuEnv } from '../menu/menuEnv';
import { fastForward, integrateRows, startIntegrate } from './integrate';

/** The Integrate group of a branch label's menu (spec #2 §13.1). Rows come from the snapshot: the
 * busy state is the active worktree's `inProgress`, already in the graph. */
export const offIntegrateMenu = registerMenu<CommitTarget, MenuEnv>({
  id: 'commit.integrate', kind: 'commit', group: 'integrate', order: 0,
  when: (t, env) => !!t.branch && !t.isWip && !t.isStash && !!env.write,
  rows: (t, env) => {
    const ctx = env.write!;
    const x = env.headBranch;
    // Integrate acts on HEAD: a detached HEAD greys the rows (with a reason) instead of hiding them.
    const busy = env.inProgress ? `Finish or abort the ${env.inProgress} first` : !x ? 'Check out a branch first' : null;
    return integrateRows(t, env, busy, {
      ff: (y) => { if (x) void fastForward(ctx, y, x); },
      go: (kind, y, ffOnly) => { if (x) void startIntegrate(ctx, kind, y, x, ffOnly); },
    });
  },
});
