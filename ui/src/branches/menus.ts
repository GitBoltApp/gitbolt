import { ArrowUpRight, GitBranchPlus, PencilLine } from 'lucide-react';
import { registerMenu } from '../menu/registry';
import type { CommitTarget, MenuEnv } from '../menu/menuEnv';
import type { MenuRow } from '../menu/types';
import { createBranchAt } from './create';
import { deleteRow } from './delete';
import { renameBranch } from './rename';
import { pickUpstream } from './upstream';

export const anchorNow = (): DOMRect => (document.querySelector('.ctx-menu')?.getBoundingClientRect() ?? new DOMRect(200, 200, 0, 0));

export const offBranchMenus = [
  registerMenu<CommitTarget, MenuEnv>({
    id: 'branch.createHere', kind: 'commit', group: 'branch', order: 20,
    when: (t, env) => !t.isWip && !t.isStash && !!env.write,
    rows: (t, env) => [{
      kind: 'action', id: 'branch.createHere', label: 'Create branch here', icon: GitBranchPlus,
      tooltip: t.branch ? `Create a branch at ${t.branch.name}` : `Create a branch at ${t.sha.slice(0, 7)}`,
      run: () => { void createBranchAt(env.write!, { sha: t.sha, ref: t.branch?.local ?? t.branch?.remotes[0]?.fullName ?? null }, 'menu'); },
    }],
  }),
  registerMenu<CommitTarget, MenuEnv>({
    id: 'branch.setUpstream', kind: 'commit', group: 'sync', order: 30,
    when: (t, env) => !!t.branch?.local && !!env.write,
    rows: (t, env) => [{
      kind: 'action', id: 'branch.setUpstream', label: 'Set upstream', icon: ArrowUpRight, tooltip: `Choose the remote branch ${t.branch!.name} tracks`,
      run: () => pickUpstream(env.write!, t.branch!.name, anchorNow()),
    }],
  }),
  registerMenu<CommitTarget, MenuEnv>({
    id: 'branch.manage', kind: 'commit', group: 'manage', order: 0,
    when: (t, env) => !!t.branch && !!env.write,
    rows: (t, env) => {
      const local = t.branch?.local ? env.sidebar?.locals.find((b) => b.fullName === t.branch!.local) : undefined;
      const rename: MenuRow[] = local ? [{ kind: 'action', id: 'branch.rename', label: `Rename ${local.name}`, icon: PencilLine, tooltip: `Rename the local branch ${local.name}`, run: () => { void renameBranch(env.write!, local.name, local.target); } }] : [];
      const del = deleteRow(t, env);
      return [...rename, ...(del ? [del] : [])];
    },
  }),
];
