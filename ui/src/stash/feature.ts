import { ArchiveRestore, PackageOpen, Trash2 } from 'lucide-react';
import { StashIcon } from '../icons/stash';
import { activeRuntime, activeTab, registerActions } from '../app/actions';
import type { RepoCtx } from '../app/repoContext';
import { useRuntime, type TabRuntime } from '../app/runtime';
import type { CommitTarget, MenuEnv, SidebarTarget, WipTarget } from '../menu/menuEnv';
import { registerMenu } from '../menu/registry';
import type { MenuRow } from '../menu/types';
import { registerToolbarButton, type ButtonView } from '../toolbar/registry';
import type { WriteCtx } from '../write/client';
import { applyStash, dropStash, stashPushFor } from './actions';

const writeCtx = (): WriteCtx | null => {
  const t = activeTab();
  const rt = activeRuntime();
  return t?.kind === 'repo' && rt?.repo ? { tabId: t.id, repoId: rt.repo.id, worktree: rt.worktree ?? rt.repo.path } : null;
};
const newest = (rt: TabRuntime | null | undefined) => rt?.sidebar?.stashes[0] ?? null;
/** The active worktree has a WIP row: something to stash. */
const dirty = (rt: TabRuntime | null | undefined) => {
  const wt = rt?.worktree ?? rt?.repo?.path;
  return !!wt && !!rt?.graph?.rows.some((r) => r.wip?.worktreePath === wt);
};

const rows = (ctx: WriteCtx, oid: string): MenuRow[] => [
  { kind: 'action', id: 'stash.apply', label: 'Apply', icon: PackageOpen, tooltip: 'Apply the stash and keep it (staged changes come back staged)', run: () => { void applyStash(ctx, oid, false); } },
  { kind: 'action', id: 'stash.pop', label: 'Pop', icon: ArchiveRestore, tooltip: 'Apply the stash, then delete it (you can undo this)', run: () => { void applyStash(ctx, oid, true); } },
  { kind: 'action', id: 'stash.drop', label: 'Delete', icon: Trash2, tooltip: 'Delete the stash (you can undo this)', run: () => { void dropStash(ctx, oid); } },
];

const stashView = ({ tabId }: RepoCtx): ButtonView =>
  dirty(useRuntime((s) => s.tabs[tabId])) ? { tooltip: 'Stash every change, named from the WIP message', disabled: false } : { tooltip: 'No changes to stash', disabled: true };
const popView = ({ tabId }: RepoCtx): ButtonView => {
  const top = newest(useRuntime((s) => s.tabs[tabId]));
  return top ? { tooltip: `Pop "${top.message}"`, disabled: false } : { tooltip: 'No stashes', disabled: true };
};

const offs = [
  registerActions([
    {
      id: 'stash.push', label: 'Stash', group: 'Repository', icon: StashIcon, tooltip: 'Stash every change, named from the WIP message',
      when: () => dirty(activeRuntime()),
      run: () => { const c = writeCtx(); if (c) void stashPushFor(c); },
    },
    {
      id: 'stash.pop', label: 'Pop', group: 'Repository', icon: ArchiveRestore, tooltip: 'Apply the newest stash and delete it',
      when: () => !!newest(activeRuntime()),
      // The oid is read at the click, so a Pop that waits in the queue acts on the stash clicked.
      run: () => { const c = writeCtx(); const s = newest(activeRuntime()); if (c && s) void applyStash(c, s.id, true); },
    },
  ]),
  registerToolbarButton({ action: 'stash.push', label: 'Stash', order: 40, useView: stashView }),
  registerToolbarButton({ action: 'stash.pop', label: 'Pop', order: 41, useView: popView }),
  registerMenu<SidebarTarget, MenuEnv>({
    id: 'sidebar.stash', kind: 'sidebar', group: 'stash', order: 0,
    when: (t, env) => t.what === 'stash' && !!env.write,
    rows: (t, env) => (t.what === 'stash' && env.write ? rows(env.write, t.sha) : []),
  }),
  registerMenu<CommitTarget, MenuEnv>({
    id: 'commit.stash', kind: 'commit', group: 'stash', order: 0,
    when: (t, env) => t.isStash && !!env.write,
    rows: (t, env) => (env.write ? rows(env.write, t.sha) : []),
  }),
  registerMenu<WipTarget, MenuEnv>({
    id: 'wip.stash', kind: 'wip', group: 'stash', order: 0,
    when: (_t, env) => !!env.write,
    rows: (t, env) => (env.write ? [{
      kind: 'action', id: 'wip.stash', label: 'Stash changes', icon: StashIcon,
      tooltip: `Stash every change in ${t.name ?? 'this worktree'}, named from its WIP message`,
      run: () => { void stashPushFor({ ...env.write!, worktree: t.worktree }); },
    }] : []),
  }),
];
import.meta.hot?.dispose(() => { for (const off of offs) off(); });
