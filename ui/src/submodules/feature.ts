import { Boxes, FolderSync, Link2, SquarePlus } from 'lucide-react';
import { activeTab, registerActions } from '../app/actions';
import type { FileTarget, MenuEnv } from '../menu/menuEnv';
import { registerMenu } from '../menu/registry';
import type { MenuRow } from '../menu/types';
import { COMMIT_QUEUED, stagingKey, useStaging } from '../stage/store';
import { useToast } from '../ui/toastStore';
import type { WriteCtx } from '../write/client';
import { writeCtx } from '../write/ctx';
import { openSubmodule, pickSubmodule, syncSubmodules, updateSubmodules } from './commands';
import { supportOf, unmappedReason } from './support';

/**
 * Submodules, only in a worktree that uses them (`RepoInfoPayload.submodules`): three palette
 * actions, and a submodule row's menu in the file lists. No sidebar section and no "Add
 * submodule" (the CLI does that).
 */
const ctx = () => {
  const t = activeTab();
  return t?.kind === 'repo' ? writeCtx(t.id) : null;
};
const usable = () => {
  const c = ctx();
  return c !== null && supportOf(c.tabId, c.worktree) !== undefined;
};

/** Runs `f` in the active worktree, or says why git's submodule commands can't run there. */
const inWorktree = (f: (c: WriteCtx) => Promise<void>) => async () => {
  const c = ctx();
  const s = c && supportOf(c.tabId, c.worktree);
  if (!c || !s) return;
  const why = unmappedReason(s);
  if (why) useToast.getState().show(why, { tone: 'warning' });
  else await f(c);
};

const row = (r: Omit<Extract<MenuRow, { kind: 'action' }>, 'kind'>): MenuRow => ({ kind: 'action', ...r });

/** A gitlink's row: one side of it is a submodule commit. */
export const isSubmoduleRow = (t: FileTarget) => t.diff.old.kind === 'submodule' || t.diff.new.kind === 'submodule';

/** A submodule row's menu (any list): Open in a tab; in a working-tree list, Update this
 * submodule. Nothing for a removed one or any other row. */
export function submoduleRows(t: FileTarget, env: Pick<MenuEnv, 'write' | 'inProgress'>): MenuRow[] {
  if (!isSubmoduleRow(t) || t.deleted) return [];
  const open = row({ id: 'file.submodule.open', label: 'Open in a tab', icon: SquarePlus, tooltip: `Open the submodule ${t.path} as a repository tab`, run: () => void openSubmodule(t.root, t.path) });
  const worktree = t.wip?.worktree ?? (t.list === 'worktree' ? t.root : null);
  if (!env.write || worktree === null) return [open];
  const c = { ...env.write, worktree };
  const s = supportOf(c.tabId, worktree);
  // As its neighbours (Stage, Discard): not while a commit is queued, nor mid-merge or rebase (the
  // write refuses then).
  const disabledReason = (s && unmappedReason(s))
    || (useStaging.getState().committing[stagingKey(c.repoId, worktree)] ? COMMIT_QUEUED : undefined)
    || (env.inProgress ? `Finish or abort the ${env.inProgress} first` : undefined);
  return [open, row({ id: 'file.submodule.update', label: 'Update this submodule', icon: FolderSync, tooltip: `Check out ${t.path} at its recorded commit (git submodule update --init --recursive -- ${t.path})`, run: () => void updateSubmodules(c, t.path), disabledReason })];
}

const offs = [
  registerActions([
    {
      id: 'submodule.update', label: 'Submodules: Update', group: 'Repository', section: 'Submodules', icon: FolderSync, shortcuts: ['Mod+Alt+B'],
      tooltip: 'Check out each submodule at its recorded commit, cloning any not initialised yet (git submodule update --init --recursive)',
      when: usable,
      run: inWorktree((c) => updateSubmodules(c)),
    },
    {
      id: 'submodule.sync', label: 'Submodules: Sync URLs', group: 'Repository', section: 'Submodules', icon: Link2,
      tooltip: "Copy the submodules' URLs from .gitmodules into the config (git submodule sync --recursive)",
      when: usable,
      run: inWorktree(syncSubmodules),
    },
    {
      id: 'submodule.open', label: 'Submodules: Open in a tab…', group: 'Repository', section: 'Submodules', icon: Boxes, shortcuts: ['Mod+Alt+O'],
      tooltip: 'Choose a submodule to open as a repository tab',
      when: usable,
      run: inWorktree(pickSubmodule),
    },
  ]),
  registerMenu<FileTarget, MenuEnv>({ id: 'file.submodule', kind: 'file', group: 'submodule', order: 0, rows: submoduleRows }),
];
import.meta.hot?.dispose(() => { for (const off of offs) off(); });
