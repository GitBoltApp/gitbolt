import { api } from '../api/client';
import type { GbError } from '../api/gen/GbError';
import type { LocalBranch } from '../api/gen/LocalBranch';
import type { PushTarget } from '../api/gen/PushTarget';
import { openDebug } from '../app/activityLog';
import { useRuntime } from '../app/runtime';
import { confirmAction } from '../ui/ConfirmDialog';
import { ERROR_TOAST_MS, useToast } from '../ui/toast';
import { runWrite, type WriteCtx } from '../write/client';
import { askPushTarget } from './PushUpstreamDialog';
import { showServerResult } from './serverOutput';

/** The tab's sidebar branch named `name` (its upstream, push target, counts): the snapshot. */
export const branchOf = (tabId: string, name: string | null): LocalBranch | undefined =>
  name ? useRuntime.getState().tabs[tabId]?.sidebar?.locals.find((b) => b.name === name) : undefined;

/** The branch the tab's active worktree has checked out, by its short name (`main`), from the
 * loaded graph (null: detached). The graph spells it as the full ref. */
export function headBranchOf(tabId: string): string | null {
  const rt = useRuntime.getState().tabs[tabId];
  const active = rt?.worktree ?? rt?.repo?.path;
  const wt = rt?.graph?.worktrees.find((w) => w.path === active);
  const ref = wt ? wt.branch : rt?.graph?.head.branch ?? null;
  return ref?.replace(/^refs\/heads\//, '') ?? null;
}

/** The remote a new upstream defaults to: `origin` when there is one, else the first. */
export function defaultRemote(tabId: string): string {
  const names = (useRuntime.getState().tabs[tabId]?.sidebar?.remotes ?? []).map((g) => g.name);
  return names.includes('origin') ? 'origin' : (names[0] ?? 'origin');
}

export function pushTooltip(b: LocalBranch | undefined, head: string | null, remote = 'origin'): { tooltip: string; disabled: boolean } {
  if (!head) return { tooltip: 'HEAD is detached', disabled: true };
  if (!b) return { tooltip: 'Push the current branch', disabled: true };
  if (b.pushTarget) return { tooltip: `Push ${b.name} to ${b.pushTarget}`, disabled: false };
  return { tooltip: `Push ${b.name} to ${remote} and track it`, disabled: false };
}

/** The force confirmation (spec #2 §12.3): what the push replaces, counted from the snapshot. */
export function forceText(b: LocalBranch): string {
  const n = b.pushBehind ?? 0;
  if (n === 0) return `Force push ${b.name} to ${b.pushTarget}? It may replace commits on the server that aren't in ${b.name}. A push can't be undone.`;
  const what = n === 1 ? `1 commit on ${b.pushTarget} that isn't in ${b.name}` : `${n} commits on ${b.pushTarget} that aren't in ${b.name}`;
  return `Force push ${b.name} to ${b.pushTarget}? It replaces ${what}. A push can't be undone.`;
}

/** The remote-tracking oid the snapshot shows for the push target: the lease (spec #2 §12.3). */
function leaseOf(tabId: string, b: LocalBranch): string | null {
  const groups = useRuntime.getState().tabs[tabId]?.sidebar?.remotes ?? [];
  for (const g of groups) {
    const hit = g.branches.find((r) => `${g.name}/${r.name}` === b.pushTarget);
    if (hit) return hit.target;
  }
  return null;
}

/** T19 sets `pull` (the rejection toast's [Pull]), so this module doesn't import the pull feature. */
export const pushHooks: { pull: ((ctx: WriteCtx, branch: string) => void) | null } = { pull: null };

function rejected(ctx: WriteCtx, b: LocalBranch, err: GbError, target: string): void {
  const pull = pushHooks.pull;
  useToast.getState().show(`${target} has commits ${b.name} doesn't have`, {
    ms: ERROR_TOAST_MS,
    actions: [
      ...(pull ? [{ label: 'Pull', run: () => pull(ctx, b.name) }] : []),
      ...(b.pushTarget ? [{ label: 'Force push…', run: () => void forcePush(ctx, branchOf(ctx.tabId, b.name) ?? b) }] : []),
      { label: 'Details', run: () => openDebug('commands', err.commandId ?? null) },
    ],
  });
}

async function send(ctx: WriteCtx, b: LocalBranch, opts: { target?: PushTarget; setUpstream?: boolean; lease?: { oid: string | null } }): Promise<void> {
  const shown = opts.target ? `${opts.target.remote}/${opts.target.branch}` : (b.pushTarget ?? b.name);
  await runWrite(ctx, () => api.push(ctx.repoId, ctx.worktree, b.name, { ...opts, expect: { head: null, refs: { [b.fullName]: b.target } } }), {
    onSuccess: (o) => {
      const dst = `${o.remote}/${o.dst}`;
      showServerResult(o.upToDate ? `${dst} is up to date` : `Pushed ${o.branch} to ${dst}`, `Pushed ${o.branch} to ${dst}; the server reported a problem`, o.server, o.op);
    },
    handle: (err) => {
      if (err.kind !== 'NonFastForward') return false;
      rejected(ctx, b, err, shown);
      return true;
    },
  });
}

/** Push: to the branch's target; with none, asks where (and tracks it). */
export async function pushBranch(ctx: WriteCtx, b: LocalBranch): Promise<void> {
  if (!b.pushTarget) return openPushUpstream(ctx, b);
  return send(ctx, b, {});
}

/** "Push main to [origin ▾] / [main] and track it?" */
export async function openPushUpstream(ctx: WriteCtx, b: LocalBranch): Promise<void> {
  const remotes = (useRuntime.getState().tabs[ctx.tabId]?.sidebar?.remotes ?? []).map((g) => g.name);
  if (remotes.length === 0) {
    useToast.getState().show(`${b.name} has no upstream and this repository has no remote`, { ms: ERROR_TOAST_MS });
    return;
  }
  const target = await askPushTarget(b.name, remotes);
  if (target) await send(ctx, b, { target, setUpstream: true });
}

/** Force push with a lease on the remote-tracking oid shown now, after a confirmation. */
export async function forcePush(ctx: WriteCtx, b: LocalBranch): Promise<void> {
  if (!b.pushTarget) return;
  const oid = leaseOf(ctx.tabId, b);
  if (!(await confirmAction({ title: 'Force push?', body: forceText(b), confirmLabel: 'Force push', danger: true }))) return;
  await send(ctx, b, { lease: { oid } });
}
