import type { CommitTarget, MenuEnv } from '../../menu/menuEnv';
import { registerMenu } from '../../menu/registry';
import { forgeTarget } from './deps';
import { stackEnvOf } from './env';
import { afterMergeRow, retargetAndRebase } from './retarget';
import { startAfterMergeWatch } from './watch';

/** After a stack's bottom merges (spec #4 §4 4D): the Integrate row (after Rebase stack, order 20) and the prompt. */
const offs = [
  registerMenu<CommitTarget, MenuEnv>({
    id: 'stack.forge.afterMerge', kind: 'commit', group: 'integrate', order: 25,
    when: (t, env) => !!t.branch?.local && !t.isWip && !t.isStash && !!env.write,
    rows: (t, env) => {
      const ctx = env.write!;
      const target = forgeTarget(ctx.tabId);
      return afterMergeRow(t, env, target, stackEnvOf(ctx.tabId), (a) => { if (target) void retargetAndRebase(ctx, a, target); });
    },
  }),
  startAfterMergeWatch(),
];
import.meta.hot?.dispose(() => { for (const off of offs) off(); });
