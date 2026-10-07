import { api, errorMessage } from '../../api/client';
import type { ForgeMr } from '../../api/gen/ForgeMr';
import type { ForgeProject } from '../../api/gen/ForgeProject';
import { selectCommit } from '../../app/graphNav';
import { runFetch } from '../../app/fetchSchedule';
import { useRuntime } from '../../app/runtime';
import { checkoutLocal, checkoutRemote } from '../../branches/checkout';
import { addForkRemote } from '../../remotes/addRemote';
import { hostName } from '../../remotes/match';
import { useToast } from '../../ui/toastStore';
import { openCreateWorktree } from '../../worktrees/CreateWorktreeDialog';
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

const trackRef = (remote: string, mr: ForgeMr) => `refs/remotes/${remote}/${mr.sourceBranch}`;

/** The local branch that already tracks the MR's source branch on `remote`, as the sidebar knows it. */
const trackingLocal = (tabId: string, remote: string, mr: ForgeMr) => tabOf(tabId)?.sidebar?.locals.find((l) => l.upstream === trackRef(remote, mr));

/** The Check out button's label, and why it's disabled (null: it isn't). */
export function checkoutState(tabId: string, mr: ForgeMr): { label: string; disabled: string | null } {
  if (unreadableSource(mr)) return { label: 'Check out', disabled: "The source project isn't readable" };
  const remote = sourceRemote(tabId, mr);
  if (!remote) return { label: `Add ${ownerOf(mr.sourceProject).split('/').pop()}'s fork and check out`, disabled: null };
  const head = tabOf(tabId)?.sidebar?.locals.find((l) => l.isHead);
  if (head?.upstream === trackRef(remote, mr)) return { label: 'Checked out', disabled: `${head.name} is checked out` };
  return { label: 'Check out', disabled: null };
}

/**
 * Why the MR's branch can't go into a new worktree, from what's loaded (no request): its source
 * project isn't readable, or the local branch tracking it is already checked out in a worktree.
 * Null: nothing known stops it (a fork without a remote, or a branch not fetched yet, is found
 * out on the click). `shown`: how a worktree's path is said (`../shop-x`).
 */
export function worktreeBlocked(tabId: string, mr: ForgeMr, shown: (path: string) => string = (p) => p): string | null {
  if (unreadableSource(mr)) return "The source project isn't readable";
  const remote = sourceRemote(tabId, mr);
  const local = remote ? trackingLocal(tabId, remote, mr) : undefined;
  return local?.checkedOut ? `${local.name} is checked out in ${shown(local.checkedOut)}` : null;
}

/** Where the MR's source branch lands locally: a local branch already tracking it (`local`), or
 * `name`, a new local branch to create from `remote`/`mr.sourceBranch` at `tip`. */
export type MrBranch =
  | { kind: 'local'; remote: string; name: string }
  | { kind: 'remote'; remote: string; name: string; tip: string };

/**
 * The shared first half of Check out (spec #4 §4 "4B"; §2 "Add <owner>'s fork and check out the
 * branch"), in place or in a new worktree: from a fork without a remote, 4A's `addForkRemote`
 * adds and fetches it first; a local branch already tracking the source is the answer; else the
 * remote branch (fetching that remote first when it isn't there yet), under its own name, or
 * `<remote>-<branch>` when a local branch of that name tracks something else (that one is never
 * moved). Every write goes through the write pipeline. Null: it can't (a toast said why).
 */
export async function resolveMrBranch(tabId: string, mr: ForgeMr): Promise<MrBranch | null> {
  const repo = tabOf(tabId)?.repo?.id;
  if (repo === undefined || unreadableSource(mr)) return null;
  let remote = sourceRemote(tabId, mr);
  if (!remote) {
    let fork: ForgeProject;
    try {
      fork = await api.forgeProjectByPath(repo, mr.sourceProject);
    } catch (e) {
      useToast.getState().show(`Couldn't find ${mr.sourceProject}: ${errorMessage(e)}`, { error: true });
      return null;
    }
    remote = await addForkRemote(tabId, fork);
    if (!remote) return null;
    await useRuntime.getState().refresh(tabId);
  }
  const local = trackingLocal(tabId, remote, mr);
  if (local) return { kind: 'local', remote, name: local.name };
  let tip = remoteTip(tabId, remote, mr.sourceBranch);
  if (!tip) {
    await runFetch(tabId, false, remote);
    await useRuntime.getState().refresh(tabId);
    tip = remoteTip(tabId, remote, mr.sourceBranch);
  }
  if (!tip) {
    useToast.getState().show(`${remote}/${mr.sourceBranch} isn't on the remote any more`);
    return null;
  }
  const clash = tabOf(tabId)?.sidebar?.locals.some((l) => l.name === mr.sourceBranch);
  if (!clash) return { kind: 'remote', remote, name: mr.sourceBranch, tip };
  const alt = `${remote}-${mr.sourceBranch}`;
  const existing = tabOf(tabId)?.sidebar?.locals.find((l) => l.name === alt);
  if (existing && existing.upstream === trackRef(remote, mr)) return { kind: 'local', remote, name: alt };
  return { kind: 'remote', remote, name: alt, tip };
}

/** Check out the MR's source branch: `resolveMrBranch`, then switch to that branch, or create it. */
export async function checkoutMr(tabId: string, mr: ForgeMr): Promise<void> {
  const b = await resolveMrBranch(tabId, mr);
  if (!b) return;
  if (b.kind === 'local') await checkoutLocal(tabId, b.name);
  else if (b.name === mr.sourceBranch) await checkoutRemote(tabId, b.remote, mr.sourceBranch, b.tip);
  else await checkoutRemote(tabId, b.remote, mr.sourceBranch, b.tip, b.name);
  // Done (the write refreshed the tab): the branch is HEAD now, so its tip is selected in the graph.
  // A failure or a cancel leaves HEAD elsewhere and the selection alone; focus stays where it was.
  const head = tabOf(tabId)?.sidebar?.locals.find((l) => l.isHead && l.name === b.name);
  if (head) selectCommit(tabId, head.target, { focus: false });
}

/**
 * Check out in a new worktree: `resolveMrBranch` (the fork's remote added, the branch fetched),
 * then the Create worktree dialog, pre-filled with that branch (it suggests the folder from the
 * name): the local branch already tracking it, or a new one from the remote branch.
 */
export async function checkoutMrInWorktree(tabId: string, mr: ForgeMr): Promise<void> {
  const b = await resolveMrBranch(tabId, mr);
  if (!b) return;
  if (b.kind === 'remote') {
    openCreateWorktree({ tabId, at: b.tip, branch: { kind: 'remote', remote: b.remote, branch: mr.sourceBranch, name: b.name } });
    return;
  }
  const local = tabOf(tabId)?.sidebar?.locals.find((l) => l.name === b.name);
  if (local?.checkedOut) {
    useToast.getState().show(`${b.name} is checked out in ${local.checkedOut}`);
    return;
  }
  openCreateWorktree({ tabId, at: local?.target ?? mr.headSha ?? '', branch: { kind: 'existing', name: b.name } });
}
