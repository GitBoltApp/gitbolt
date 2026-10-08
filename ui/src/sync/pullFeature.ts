import { ArrowDownToLine } from 'lucide-react';
import { activeTab, registerActions } from '../app/actions';
import { useAppState } from '../app/state';
import { isTypingOrEditor } from '../ui/keys';
import { writeCtx } from '../write/ctx';
import { registerSyncRows } from './menus';
import { MODE_OF, pull, pullRow } from './pull';
import { branchOf, headBranchOf, pushHooks } from './push';

/** The active repo tab's write target, when its checked-out branch has an upstream to pull. */
function pullCtx() {
  const t = activeTab();
  if (t?.kind !== 'repo') return null;
  const b = branchOf(t.id, headBranchOf(t.id));
  return b?.upstream && !b.gone ? writeCtx(t.id) : null;
}

/** The Sync row's Pull (order 0, above Push) and Push's rejection toast [Pull] (spec #2 §12.2). */
const offs = [
  // Ctrl+Shift+L, beside Fetch all's Ctrl+L: in the Pull button's mode, or fast-forward if
  // possible while the button fetches. In an editor, Monaco's (and VS Code's) Select all
  // occurrences.
  registerActions([{
    id: 'sync.pull', label: 'Pull', group: 'Repository', icon: ArrowDownToLine, tooltip: "Pull the current branch's upstream", shortcuts: ['Mod+Shift+L'],
    yieldsTo: isTypingOrEditor,
    when: () => pullCtx() !== null,
    run: () => {
      const ctx = pullCtx();
      const mode = useAppState.getState().settings.syncButton;
      return ctx ? pull(ctx, mode === 'fetchAll' ? 'ffOrMerge' : MODE_OF[mode]) : undefined;
    },
  }]),
  registerSyncRows(0, (t, env) => {
    const local = t.branch?.local ? env.sidebar?.locals.find((b) => b.fullName === t.branch!.local) : undefined;
    const ctx = env.write;
    if (!local || !ctx) return [];
    const row = pullRow(local, (mode) => { void pull(ctx, mode, local.isHead ? undefined : local.name); });
    return row ? [row] : [];
  }),
];
pushHooks.pull = (ctx, branch) => { void pull(ctx, 'ffOnly', branch === headBranchOf(ctx.tabId) ? undefined : branch); };
import.meta.hot?.dispose(() => {
  for (const off of offs) off();
  pushHooks.pull = null;
});
