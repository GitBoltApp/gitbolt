import { api, errorMessage } from '../../api/client';
import type { ForgeMr } from '../../api/gen/ForgeMr';
import type { ForgeProject } from '../../api/gen/ForgeProject';
import { runFetch } from '../../app/fetchSchedule';
import { useRuntime } from '../../app/runtime';
import { checkoutLocal, checkoutRemote } from '../../branches/checkout';
import { addForkRemote } from '../../remotes/addRemote';
import { hostName } from '../../remotes/match';
import { useToast } from '../../ui/toast';
import { forgeOf } from '../mrStore';
import { ownerOf } from '../mrText';

const tabOf = (tabId: string) => useRuntime.getState().tabs[tabId];

/** A project path as forges compare it: case-insensitive, without a trailing `.git` or slash. */
const barePath = (path: string | null | undefined): string => (path ?? '').trim().replace(/\/+$/, '').replace(/\.git$/i, '').toLowerCase();

/** The MR's source project couldn't be read: GitHub's "" (a deleted fork), GitLab's `project <id>`. */
export const unreadableSource = (mr: ForgeMr): boolean => mr.sourceProject === '' || /^project \d+$/.test(mr.sourceProject);

/** The repository's remote on the MR's source project, if it has one (the host without its port,
 * the path in any case). */
export function sourceRemote(tabId: string, mr: ForgeMr): string | null {
  if (unreadableSource(mr)) return null;
  const host = hostName(forgeOf(tabId).project?.host);
  if (!host) return null;
  const path = barePath(mr.sourceProject);
  return tabOf(tabId)?.info?.remotes.find((r) => hostName(r.host) === host && barePath(r.path) === path)?.name ?? null;
}

const remoteTip = (tabId: string, remote: string, branch: string): string | null =>
  tabOf(tabId)?.sidebar?.remotes.find((g) => g.name === remote)?.branches.find((b) => b.name === branch)?.target ?? null;

/** The Check out button's label, and why it's disabled (null: it isn't). */
export function checkoutState(tabId: string, mr: ForgeMr): { label: string; disabled: string | null } {
  if (unreadableSource(mr)) return { label: 'Check out', disabled: "The source project isn't readable" };
  const remote = sourceRemote(tabId, mr);
  if (!remote) return { label: `Add ${ownerOf(mr.sourceProject).split('/').pop()}'s fork and check out`, disabled: null };
  const head = tabOf(tabId)?.sidebar?.locals.find((l) => l.isHead);
  if (head?.upstream === `refs/remotes/${remote}/${mr.sourceBranch}`) return { label: 'Checked out', disabled: `${head.name} is checked out` };
  return { label: 'Check out', disabled: null };
}

/**
 * Check out the MR's source branch (spec #4 §4 "4B"; §2 "Add <owner>'s fork and check out the
 * branch"): a local branch already tracking it; else the remote branch as a new local one
 * (fetching that remote first when it isn't there yet); from a fork without a remote, 4A's
 * `addForkRemote` adds and fetches it first. Every step goes through the write pipeline.
 */
export async function checkoutMr(tabId: string, mr: ForgeMr): Promise<void> {
  const repo = tabOf(tabId)?.repo?.id;
  if (repo === undefined || unreadableSource(mr)) return;
  let remote = sourceRemote(tabId, mr);
  if (!remote) {
    let fork: ForgeProject;
    try {
      fork = await api.forgeProjectByPath(repo, mr.sourceProject);
    } catch (e) {
      useToast.getState().show(`Couldn't find ${mr.sourceProject}: ${errorMessage(e)}`, { error: true });
      return;
    }
    remote = await addForkRemote(tabId, fork);
    if (!remote) return;
    await useRuntime.getState().refresh(tabId);
  }
  const local = tabOf(tabId)?.sidebar?.locals.find((l) => l.upstream === `refs/remotes/${remote}/${mr.sourceBranch}`);
  if (local) {
    checkoutLocal(tabId, local.name);
    return;
  }
  let tip = remoteTip(tabId, remote, mr.sourceBranch);
  if (!tip) {
    await runFetch(tabId, false, remote);
    await useRuntime.getState().refresh(tabId);
    tip = remoteTip(tabId, remote, mr.sourceBranch);
  }
  if (!tip) {
    useToast.getState().show(`${remote}/${mr.sourceBranch} isn't on the remote any more`);
    return;
  }
  // A local branch of that name that tracks something else is never moved: the new one is `<remote>-<branch>`.
  const clash = tabOf(tabId)?.sidebar?.locals.some((l) => l.name === mr.sourceBranch);
  if (!clash) {
    await checkoutRemote(tabId, remote, mr.sourceBranch, tip);
    return;
  }
  const alt = `${remote}-${mr.sourceBranch}`;
  const existing = tabOf(tabId)?.sidebar?.locals.find((l) => l.name === alt);
  if (existing && existing.upstream === `refs/remotes/${remote}/${mr.sourceBranch}`) {
    checkoutLocal(tabId, alt);
    return;
  }
  await checkoutRemote(tabId, remote, mr.sourceBranch, tip, alt);
}
