import { GitBranchPlus } from 'lucide-react';
import { activeRuntime, activeTab, registerActions } from '../app/actions';
import { worktreeOf } from '../app/runtime';
import { registerToolbarButton } from '../toolbar/registry';
import { createBranchAt } from './create';
import { offBranchMenus } from './menus';
import { offUpstreamPicker } from './upstream';

/** Branches (spec #2 §9): the toolbar Branch button, and the branch rows of the commit and
 * branch-label menus. Checkout and reset register from their own modules. */
const writeCtx = () => {
  const t = activeTab();
  const rt = activeRuntime();
  const worktree = worktreeOf(rt ?? undefined);
  return t?.kind === 'repo' && rt?.repo && worktree ? { tabId: t.id, repoId: rt.repo.id, worktree } : null;
};

const offs = [
  ...offBranchMenus,
  offUpstreamPicker,
  registerActions([{
    id: 'branch.create', label: 'Branch', group: 'Repository', icon: GitBranchPlus, tooltip: 'Create a branch at HEAD',
    when: () => !!writeCtx() && !!activeRuntime()?.graph?.head.target,
    run: () => {
      const ctx = writeCtx();
      const head = activeRuntime()?.graph?.head;
      if (ctx && head?.target) void createBranchAt(ctx, { sha: head.target, ref: head.branch }, 'toolbar');
    },
  }]),
  registerToolbarButton({ action: 'branch.create', label: 'Branch', order: 30 }),
];
import.meta.hot?.dispose(() => { for (const off of offs) off(); });
