import { registerSyncRows } from './menus';
import { pull, pullRow } from './pull';
import { headBranchOf, pushHooks } from './push';

/** The Sync row's Pull (order 0, above Push) and Push's rejection toast [Pull] (spec #2 §12.2). */
const offs = [
  registerSyncRows(0, (t, env) => {
    const local = t.branch?.local ? env.sidebar?.locals.find((b) => b.fullName === t.branch!.local) : undefined;
    const ctx = env.write;
    if (!local || !ctx) return [];
    return [pullRow(local, (mode) => { void pull(ctx, mode, local.isHead ? undefined : local.name); })];
  }),
];
pushHooks.pull = (ctx, branch) => { void pull(ctx, 'ffOnly', branch === headBranchOf(ctx.tabId) ? undefined : branch); };
import.meta.hot?.dispose(() => {
  for (const off of offs) off();
  pushHooks.pull = null;
});
