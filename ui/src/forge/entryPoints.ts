import { GitPullRequest } from 'lucide-react';
import type { ForgeMr } from '../api/gen/ForgeMr';
import { activeTab, registerActions } from '../app/actions';
import { useRuntime } from '../app/runtime';
import type { BranchRef, CommitTarget, MenuEnv } from '../menu/menuEnv';
import { registerMenu } from '../menu/registry';
import type { MenuRow } from '../menu/types';
import { mrName, mrNoun, mrRef } from './labels';
import { forgeOf, mrForLabel, mrForUpstream, type TabForge } from './mrStore';
import { openMrView } from './poll';

/** The MRs/PRs of some branches, once each. */
export function mrsForBranches(f: TabForge, branches: BranchRef[]): ForgeMr[] {
  const out = new Map<number, ForgeMr>();
  for (const b of branches) {
    const hit = mrForLabel(f, b);
    if (hit) out.set(hit.mr.number, hit.mr);
  }
  return [...out.values()];
}

/** "Open MR !12" (spec #4 §4 "4B": branch menus, and the branch's last commit), before the
 * message's own `Open !n` rows, which open the browser. */
const offMenu = registerMenu<CommitTarget, MenuEnv>({
  id: 'commit.forge.openMr',
  kind: 'commit',
  group: 'forge',
  order: -1,
  when: (t) => !t.isWip && !t.isStash,
  rows: (t, env) => {
    const tabId = env.write?.tabId;
    if (!tabId) return [];
    const f = forgeOf(tabId);
    const kind = f.kind;
    if (!kind) return [];
    const branches: BranchRef[] = t.branch ? [t.branch] : env.labelsAt(t.sha).filter((l) => !l.tag).map((l) => ({ name: l.name, local: l.local, remotes: l.remotes }));
    return mrsForBranches(f, branches).map((mr): MenuRow => ({
      kind: 'action',
      id: `commit.openMr.${mr.number}`,
      label: `Open ${mrNoun(kind)} ${mrRef(kind, mr.number)}`,
      icon: GitPullRequest,
      tooltip: `Show ${mrName(kind).toLowerCase()} ${mrRef(kind, mr.number)} (${mr.title}) in GitBolt`,
      run: () => openMrView(tabId, mr.number),
    }));
  },
});

/** The active tab's checked-out branch's MR/PR, if it has one. */
export function currentBranchMr(): { tabId: string; mr: ForgeMr } | null {
  const tab = activeTab();
  if (!tab) return null;
  const head = useRuntime.getState().tabs[tab.id]?.sidebar?.locals.find((l) => l.isHead);
  const f = forgeOf(tab.id);
  const mr = head && f.kind ? mrForUpstream(f, head.upstream) : null;
  return mr ? { tabId: tab.id, mr } : null;
}

const offActions = registerActions([
  {
    id: 'forge.openMr',
    label: 'Open MR/PR for the current branch',
    group: 'Repository',
    icon: GitPullRequest,
    tooltip: "Show the current branch's merge request or pull request",
    when: () => currentBranchMr() !== null,
    run: () => {
      const c = currentBranchMr();
      if (c) openMrView(c.tabId, c.mr.number);
    },
  },
]);

import.meta.hot?.dispose(() => {
  offMenu();
  offActions();
});
