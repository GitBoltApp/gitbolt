import { GitPullRequestCreate } from 'lucide-react';
import { lazy } from 'react';
import { activeTab, registerActions } from '../../app/actions';
import type { ForgeProject } from '../../api/gen/ForgeProject';
import type { CommitTarget, MenuEnv } from '../../menu/menuEnv';
import { registerMenu } from '../../menu/registry';
import { headBranchOf, pushHooks } from '../../sync/push';
import { registerFlyout } from '../../ui/flyout/flyout';
import { forgeName, mrLongNoun, mrNoun } from '../labels';
import { forgeOf, mrForLabel } from '../mrStore';
import { CREATE_MR_FLYOUT, openCreateMr, type CreateMrArgs } from './store';

// Lazy: the flyout stays out of the startup chunk until a Create is opened.
const CreateMrFlyout = lazy(() => import('./CreateMrFlyout').then((m) => ({ default: m.CreateMrFlyout })));

/**
 * The Create MR/PR entry points (spec #4 §4 "4C", §5): branch menus (graph chips and sidebar
 * Local rows), the palette (Ctrl+P), and the push toast's link for a branch the push created. All
 * read the tab's target project from 4B's forge store (`forgeOf`, filled by its poller) and open
 * the flyout 4B's host draws.
 */

/** The repo's target, when `branch` may get an MR/PR there: not the target's default branch, and
 * no open one already from it (that branch gets 4B's "Open MR/PR" row instead). The branch's own
 * MR/PR is 4B's mapping (its remote refs, else its upstream): another project's branch of the same
 * name (a fork's `patch-1`) doesn't count. An unpushed branch qualifies: the flyout offers the push. */
export function createTarget(tabId: string, branch: string | null, remotes: ReadonlyArray<{ fullName: string }> = []): { remote: string; project: ForgeProject } | null {
  const f = forgeOf(tabId);
  const { remote, project } = f;
  if (!remote || !project || !branch || branch === project.defaultBranch) return null;
  const own = mrForLabel(f, { local: `refs/heads/${branch}`, remotes })?.mr;
  if (own && (own.state === 'open' || own.state === 'draft')) return null;
  return { remote, project };
}

const offs: Array<() => void> = [
  registerMenu<CommitTarget, MenuEnv>({
    id: 'forge.createMr', kind: 'commit', group: 'forge', order: 10,
    when: (t, env) => !!t.branch?.local && !t.isWip && !t.isStash && !!env.write,
    rows: (t, env) => {
      const name = t.branch!.local!.replace(/^refs\/heads\//, '');
      const target = createTarget(env.write!.tabId, name, t.branch!.remotes);
      if (!target) return [];
      const noun = mrLongNoun(target.project.kind);
      return [{
        kind: 'action', id: 'forge.createMr', label: `Create ${noun}…`, icon: GitPullRequestCreate,
        tooltip: `Create a ${noun} from ${name} on ${forgeName(target.project.kind)}`, run: () => openCreateMr(env.write!.tabId, name),
      }];
    },
  }),
  registerActions([{
    id: 'forge.createMr', label: 'Create MR/PR…', group: 'Repository', icon: GitPullRequestCreate,
    tooltip: 'Create a merge request or pull request from the current branch',
    when: () => {
      const t = activeTab();
      return !!t && !!createTarget(t.id, headBranchOf(t.id));
    },
    run: () => {
      const t = activeTab();
      const branch = t ? headBranchOf(t.id) : null;
      if (t && branch) openCreateMr(t.id, branch);
    },
  }]),
  registerFlyout<CreateMrArgs>(CREATE_MR_FLYOUT, CreateMrFlyout),
];

// Only for a push to a remote on the target's forge: an MR/PR can't come from elsewhere.
pushHooks.afterNewBranch = (tabId, branch, remote) => {
  const target = forgeOf(tabId).mapped.includes(remote) ? createTarget(tabId, branch) : null;
  return target ? { label: `Create ${mrNoun(target.project.kind)}`, run: () => openCreateMr(tabId, branch) } : null;
};

import.meta.hot?.dispose(() => {
  for (const off of offs) off();
  pushHooks.afterNewBranch = null;
});
