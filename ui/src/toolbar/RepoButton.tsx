import { Check, FolderGit2, SquarePlus } from 'lucide-react';
import { useRepoContext } from '../app/repoContext';
import { useRuntime } from '../app/runtime';
import { openMenuAt } from '../menu/menuStore';
import type { MenuRow } from '../menu/types';
import { HoverTooltip } from '../ui/HoverTooltip';
import { openWorktreeTab, setActiveWorktree } from '../worktrees/active';
import { worktreeDisplay } from '../worktrees/paths';

const nameOf = (p: string) => p.slice(p.lastIndexOf('/') + 1);

function rows(tabId: string): MenuRow[] {
  const rt = useRuntime.getState().tabs[tabId];
  const wts = rt?.graph?.worktrees ?? [];
  const main = wts.find((w) => w.isMain)?.path ?? rt?.repo?.path ?? '';
  return wts.map((w): MenuRow => ({
    kind: 'action', id: `repo.worktree:${w.path}`,
    label: `${worktreeDisplay(main, w.path)}${w.branch ? ` · ${w.branch.replace(/^refs\/heads\//, '')}` : ''}`,
    icon: w.path === rt?.worktree ? Check : FolderGit2,
    tooltip: w.path === rt?.worktree ? "This tab's worktree" : `Switch this tab to ${worktreeDisplay(main, w.path)}`,
    run: () => setActiveWorktree(tabId, w.path),
    variants: [{ id: 'tab', icon: SquarePlus, tooltip: 'Open in a new tab', run: () => { void openWorktreeTab(tabId, w.path); } }],
  }));
}

/** The palette's "Switch worktree…": the same menu, at the button. */
export function openRepoMenu(tabId: string): void {
  const el = document.querySelector<HTMLElement>(`[data-tab-id="${tabId}"] [data-testid="tb-repo"]`) ?? document.querySelector<HTMLElement>('[data-testid="tb-repo"]');
  if (el) openMenuAt(el, rows(tabId), undefined, () => rows(tabId), 'Worktrees');
}

/** The toolbar's repository field: the repository's name, the active worktree's folder after it
 * when that isn't the main one, and the list of the repository's worktrees to switch between. */
export function RepoButton() {
  const { tabId } = useRepoContext();
  const name = useRuntime((s) => s.tabs[tabId]?.repo?.name);
  const sub = useRuntime((s) => {
    const rt = s.tabs[tabId];
    const main = rt?.graph?.worktrees.find((w) => w.isMain)?.path;
    return rt?.worktree && main && rt.worktree !== main ? nameOf(rt.worktree) : null;
  });
  return (
    <HoverTooltip content="Worktrees of this repository">
      <button type="button" className="tb-field tb-picker" data-testid="tb-repo" aria-haspopup="menu" aria-label={`Repository: ${name}${sub ? ` (${sub})` : ''}`} onClick={(e) => openMenuAt(e.currentTarget, rows(tabId), undefined, () => rows(tabId), 'Worktrees')}>
        <span className="tb-caption">repository</span>
        <span className="tb-value">{name}{sub && <span className="tb-sub"> · {sub}</span>}</span>
      </button>
    </HoverTooltip>
  );
}
