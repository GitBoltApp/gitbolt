import { Trash2 } from 'lucide-react';
import { api } from '../api/client';
import type { RemoteBranchRef } from '../api/gen/RemoteBranchRef';
import type { CommitTarget, MenuEnv } from '../menu/menuEnv';
import type { MenuRow, Variant } from '../menu/types';
import { currentOrigin, type Origin } from '../ui/arm/origin';
import { holdOrigin } from '../ui/arm/store';
import { confirmAction } from '../ui/ConfirmDialog';
import { runWrite, type WriteCtx } from '../write/client';

/** `unpushed`: the local branch's commits that aren't on the remote branch being deleted with it
 * (the sidebar's `ahead`), when that remote branch is its upstream; Both's one dialog names them. */
export interface DeletePlan { branch: string; local: { oid: string } | null; remote: RemoteBranchRef | null; unpushed?: number }

/** What the clicked label stands for: its local branch (with where it's checked out), and its
 * remote counterpart (the local branch's upstream, else a same-named origin branch; for a
 * remote-only label, the remote itself), all from the loaded sidebar. */
function resolve(t: CommitTarget, env: MenuEnv): { plan: DeletePlan; localWhy: string | null; remoteWhy: string | null } | null {
  if (!t.branch || !env.sidebar) return null;
  const sidebar = env.sidebar;
  const b = t.branch;
  const local = b.local ? sidebar.locals.find((l) => l.fullName === b.local) ?? null : null;
  const remoteBranch = (full: string | null) => {
    if (!full) return null;
    for (const g of sidebar.remotes) {
      const hit = g.branches.find((x) => x.fullName === full);
      if (hit) return { ref: { remote: g.name, branch: hit.name, lease: hit.target }, full };
    }
    return null;
  };
  const found = local
    ? remoteBranch(!local.gone ? local.upstream : null) ?? remoteBranch(`refs/remotes/origin/${local.name}`)
    : remoteBranch(b.remotes[0]?.fullName ?? `refs/remotes/origin/${b.name}`);
  const remote = found?.ref ?? null;
  const unpushed = local && found && local.upstream === found.full && !local.gone && local.ahead > 0 ? local.ahead : undefined;
  const localWhy = !local ? 'No local branch' : local.checkedOut === env.activeWorktree ? 'Checked out' : local.checkedOut ? `Checked out in ${env.worktreeShown(local.checkedOut)}` : null;
  return { plan: { branch: local?.name ?? b.name, local: local ? { oid: local.target } : null, remote, unpushed }, localWhy, remoteWhy: remote ? null : 'No remote branch' };
}

/** `Delete | Local | Remote | Both |` (§9.2): the clicked control decides; no checkbox dialog. */
export function deleteRow(t: CommitTarget, env: MenuEnv): MenuRow | null {
  const r = resolve(t, env);
  if (!r || !env.write) return null;
  const ctx = env.write;
  const { plan, localWhy, remoteWhy } = r;
  const remoteName = plan.remote ? `${plan.remote.remote}/${plan.remote.branch}` : '';
  const go = (local: boolean, remote: boolean) => () => void deleteBranch(ctx, { ...plan, local: local ? plan.local : null, remote: remote ? plan.remote : null });
  // Only the variants that can run: none for a branch that's checked out and has no remote.
  const canLocal = !localWhy;
  const canRemote = !remoteWhy;
  if (!canLocal && !canRemote) return null;
  const variants: Variant[] = [
    ...(canLocal ? [{ id: 'local', label: 'Local', tooltip: `Delete the local branch ${plan.branch} (you can undo this)`, run: go(true, false) }] : []),
    ...(canRemote ? [{ id: 'remote', label: 'Remote', tooltip: `Delete ${remoteName || 'the remote branch'} from its remote (a push: can't be undone)`, run: go(false, true) }] : []),
    ...(canLocal && canRemote ? [{ id: 'both', label: 'Both', tooltip: 'Delete the remote branch, then the local one', run: go(true, true) }] : []),
  ];
  // The label: the local branch, or the remote one when the local can't go (or there's none).
  const remoteOnly = !canLocal;
  return {
    kind: 'action', id: 'branch.delete', label: 'Delete', icon: Trash2, variants,
    tooltip: remoteOnly ? `Delete ${remoteName} from ${plan.remote!.remote}` : `Delete the local branch ${plan.branch}`,
    run: remoteOnly ? go(false, true) : go(true, false),
  };
}

const commitsWord = (n: number) => `${n} ${n === 1 ? 'commit' : 'commits'}`;

/** The confirmation (§9.2) and the write. Both asks once: the remote deletion can't be undone,
 * and the unmerged count (when known) is in the same dialog, so it sends `force` after the
 * answer. A local-only delete that comes back `unmerged` (nothing ran) asks, then forces. */
export async function deleteBranch(ctx: WriteCtx, plan: DeletePlan, force = false, origin: Origin | null = currentOrigin()): Promise<void> {
  const both = !!plan.local && !!plan.remote;
  if (plan.remote && !force) {
    const name = `${plan.remote.remote}/${plan.remote.branch}`;
    const body = both
      ? `Deleting ${name} can't be undone${plan.unpushed ? `, and ${plan.branch} has ${commitsWord(plan.unpushed)} that aren't on it` : ''}. You can undo deleting the local branch.`
      : `It goes from ${plan.remote.remote}: this can't be undone.`;
    const arm = both
      ? `Click again to delete ${plan.branch} and ${name}${plan.unpushed ? ` (${commitsWord(plan.unpushed)} not on ${name})` : ''}`
      : `Click again to delete ${name} (can't be undone)`;
    const ok = await confirmAction({ title: both ? `Delete ${plan.branch} and ${name}?` : `Delete ${name}?`, body, confirmLabel: 'Delete', arm, danger: true }, origin);
    if (!ok) return;
    if (both) force = true;
  }
  const expect = { head: null, refs: plan.local ? { [`refs/heads/${plan.branch}`]: plan.local.oid } : {} };
  // A local delete may come back `unmerged`: the menu it came from stays open meanwhile, so that
  // question arms the clicked row in place (board A) instead of falling back to a popover.
  const release = force ? () => {} : holdOrigin();
  const out = await runWrite(ctx, () => api.deleteBranch(ctx.repoId, ctx.worktree, { branch: plan.branch, local: !!plan.local, remote: plan.remote, force, expect }), { origin })
    .catch((e: unknown) => { release(); throw e; });
  if (out?.status !== 'unmerged') return release();
  // Armed first, then the hold goes: the row stays armed in its open menu.
  const asked = confirmAction({
    title: `Delete ${out.branch}?`,
    body: `${out.branch} has ${commitsWord(out.commits)} that aren't in ${out.into}. You can undo this.`,
    confirmLabel: 'Delete', danger: true,
    arm: `Click again to delete ${out.branch}: ${commitsWord(out.commits)} not in ${out.into}`,
  }, origin);
  release();
  if (await asked) await deleteBranch(ctx, plan, true, origin);
}
