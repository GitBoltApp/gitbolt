import { ArrowRightLeft, FolderPlus } from 'lucide-react';
import { activeTab, registerActions } from '../app/actions';
import { tabIdOf } from '../app/tabStores';
import { registerGraphDoubleClick } from '../graph/rowActions';
import { useRuntime } from '../app/runtime';
import { registerSidebarDoubleClick, registerSidebarHeaderAction } from '../sidebar/itemActions';
import { useToast } from '../ui/toastStore';
import { openRepoMenu } from '../toolbar/RepoButton';
import { activeWorktreeOf, setActiveWorktree } from './active';
import { offCreateWorktreeDialog, openCreateWorktree } from './CreateWorktreeDialog';
import { offWorktreeMenus } from './menus';

/** The active worktree's entry points (spec #2 §11.2): double-click a sidebar worktree row or
 * another worktree's WIP row, their menus, the toolbar repo button's list, the palette. */
const offs = [
  ...offWorktreeMenus,
  offCreateWorktreeDialog,
  registerSidebarHeaderAction('worktrees', {
    id: 'worktree.create', icon: FolderPlus, label: 'Create worktree',
    run: ({ tabId }) => {
      const head = useRuntime.getState().tabs[tabId]?.graph?.head.target;
      if (head) openCreateWorktree({ tabId, at: head, branch: null });
      else useToast.getState().show('Nothing to create a worktree from: this repository has no commits yet');
    },
  }),
  registerSidebarDoubleClick('worktree', ({ tabId }, item) => { if (item.kind === 'worktree') setActiveWorktree(tabId, item.worktree.path); }),
  registerGraphDoubleClick({
    row: (store, row) => {
      const tabId = tabIdOf(store);
      const path = row.wip?.worktreePath;
      if (!tabId || !path || path === activeWorktreeOf(tabId)) return false;
      setActiveWorktree(tabId, path);
      return true;
    },
  }),
  registerActions([{
    id: 'worktree.switch', label: 'Switch worktree…', group: 'Repository', icon: ArrowRightLeft, tooltip: "Change the tab's active worktree",
    when: () => { const t = activeTab(); return t?.kind === 'repo' && !!t.path; },
    run: () => { const t = activeTab(); if (t) openRepoMenu(t.id); },
  }]),
];
import.meta.hot?.dispose(() => { for (const off of offs) off(); });
