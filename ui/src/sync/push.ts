import { api } from '../api/client';
import type { GbError } from '../api/gen/GbError';
import type { LocalBranch } from '../api/gen/LocalBranch';
import type { PushTarget } from '../api/gen/PushTarget';
import type { RewriteKind } from '../api/gen/RewriteKind';
import { openDebug } from '../app/activityLog';
import { useRuntime } from '../app/runtime';
import { currentOrigin, type Origin } from '../ui/arm/origin';
import { askChoice } from '../ui/ChoiceDialog';
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

const REWROTE: Record<RewriteKind, string> = { rebase: 'rebased', amend: 'amended' };

/** GitBolt rewrote the branch since its last push and a plain push would be rejected: Push
 * force-pushes with the lease recorded at the rewrite, without asking (spec #2 §12.3). The
 * verb, else null. */
export function rewroteSincePush(b: LocalBranch): string | null {
  return b.rewritten && b.pushTarget && (b.pushBehind ?? 0) > 0 ? REWROTE[b.rewritten.kind] : null;
}

/** Push's tooltip for a branch with a push target (the toolbar and the Sync row share it). */
export function pushLabel(b: LocalBranch): string {
  const rewrote = rewroteSincePush(b);
  if (rewrote) {
    const n = b.pushBehind ?? 0;
    return `Push (force with lease: ${rewrote}, replaces ${n} ${n === 1 ? 'commit' : 'commits'} on ${b.rewritten!.remote})`;
  }
  return b.pushTarget ? `Push ${b.name} to ${b.pushTarget}` : `Push ${b.name} to a remote and track it`;
}

export function pushTooltip(b: LocalBranch | undefined, head: string | null, remote = 'origin'): { tooltip: string; disabled: boolean } {
  if (!head) return { tooltip: 'HEAD is detached', disabled: true };
  if (!b) return { tooltip: 'Push the current branch', disabled: true };
  if (b.pushTarget) return { tooltip: pushLabel(b), disabled: false };
  return { tooltip: `Push ${b.name} to ${remote} and track it`, disabled: false };
}

/** Nothing to push (the menu hides Push): the branch pushes to its upstream, which has every
 * commit it has. Unknown for a triangular setup (a push target that isn't the upstream: `ahead`
 * counts against the upstream) or a gone upstream, so those still push. A rewritten branch
 * with nothing of its own ahead (a rewrite mark) still pushes: it replaces the remote's commits. */
export function nothingToPush(b: LocalBranch): boolean {
  const up = b.upstream?.replace(/^refs\/remotes\//, '') ?? null;
  return !!b.pushTarget && up === b.pushTarget && !b.gone && b.ahead === 0 && !rewroteSincePush(b);
}

/** The force confirmation (spec #2 §12.3): what the push replaces, counted from the snapshot. */
export function forceText(b: LocalBranch): string {
  const n = b.pushBehind ?? 0;
  if (n === 0) return `Force push ${b.name} to ${b.pushTarget}? It may replace commits on the server that aren't in ${b.name}. A push can't be undone.`;
  const what = n === 1 ? `1 commit on ${b.pushTarget} that isn't in ${b.name}` : `${n} commits on ${b.pushTarget} that aren't in ${b.name}`;
  return `Force push ${b.name} to ${b.pushTarget}? It replaces ${what}. A push can't be undone.`;
}

/** The armed Force push's label: what it replaces, when the snapshot counts it. */
export function forceArm(b: LocalBranch): string {
  const n = b.pushBehind ?? 0;
  return n === 0 ? `Click again to force push to ${b.pushTarget}` : `Click again to force push: replaces ${n} ${n === 1 ? 'commit' : 'commits'}`;
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

/** A rejected push is a real choice (spec §ui confirms, board G): a popover anchored at the Push
 * that started it, the safe Pull first (and focused), then Force push (with lease), which still
 * arms in place before it goes. */
async function rejected(ctx: WriteCtx, b: LocalBranch, err: GbError, target: string, origin: Origin | null): Promise<void> {
  const pull = pushHooks.pull;
  const now = branchOf(ctx.tabId, b.name) ?? b;
  // The lease is read with the count the armed label shows, before the question: they agree.
  const lease = leaseOf(ctx.tabId, now);
  const answer = await askChoice({
    title: `${target} has commits ${b.name} doesn't have`,
    body: `Pull them first, or replace them with a force push (a push can't be undone).`,
    choices: [
      ...(pull ? [{ id: 'pull', label: 'Pull', primary: true }] : []),
      ...(b.pushTarget ? [{ id: 'force', label: 'Force push (with lease)', danger: true, arm: forceArm(now) }] : []),
      { id: 'details', label: 'Details', quiet: true },
    ],
  }, origin);
  if (answer.choice === 'pull') pull?.(ctx, b.name);
  else if (answer.choice === 'force') await forcePush(ctx, now, { oid: lease, origin });
  else if (answer.choice === 'details') openDebug('commands', err.commandId ?? null);
}

async function send(ctx: WriteCtx, b: LocalBranch, opts: { target?: PushTarget; setUpstream?: boolean; lease?: { oid: string | null } }, origin: Origin | null = currentOrigin()): Promise<void> {
  const shown = opts.target ? `${opts.target.remote}/${opts.target.branch}` : (b.pushTarget ?? b.name);
  await runWrite(ctx, () => api.push(ctx.repoId, ctx.worktree, b.name, { ...opts, expect: { head: null, refs: { [b.fullName]: b.target } } }), {
    onSuccess: (o) => {
      const dst = `${o.remote}/${o.dst}`;
      // A rewrite mark's lease held (spec #2 §12.3): say it was forced, and why.
      const done = o.forced ? `Force-pushed ${o.branch} (with lease): it was ${REWROTE[o.forced]}` : `Pushed ${o.branch} to ${dst}`;
      showServerResult(o.upToDate ? `${dst} is up to date` : done, `${done}; the server reported a problem`, o.server, o.op);
    },
    handle: (err) => {
      if (err.kind !== 'NonFastForward') return false;
      void rejected(ctx, b, err, shown, origin);
      return true;
    },
    origin,
  });
}

/** Push: to the branch's target; with none, asks where (and tracks it). */
export async function pushBranch(ctx: WriteCtx, b: LocalBranch): Promise<void> {
  if (!b.pushTarget) return openPushUpstream(ctx, b);
  return send(ctx, b, {});
}

/** "Push main to [origin ▾] / [main] and track it?" */
export async function openPushUpstream(ctx: WriteCtx, b: LocalBranch): Promise<void> {
  const origin = currentOrigin();
  const remotes = (useRuntime.getState().tabs[ctx.tabId]?.sidebar?.remotes ?? []).map((g) => g.name);
  if (remotes.length === 0) {
    useToast.getState().show(`${b.name} has no upstream and this repository has no remote`, { ms: ERROR_TOAST_MS });
    return;
  }
  const target = await askPushTarget(b.name, remotes);
  if (target) await send(ctx, b, { target, setUpstream: true }, origin);
}

/** Force push with a lease on the remote-tracking oid shown now, after a confirmation (it arms
 * in place). `confirmed`: it already did, in the rejection's popover, with this lease (read when
 * that question showed its count) and the origin the push started from. */
export async function forcePush(ctx: WriteCtx, b: LocalBranch, confirmed?: { oid: string | null; origin: Origin | null }): Promise<void> {
  if (!b.pushTarget) return;
  const origin = confirmed ? confirmed.origin : currentOrigin();
  const oid = confirmed ? confirmed.oid : leaseOf(ctx.tabId, b);
  if (!confirmed && !(await confirmAction({ title: 'Force push?', body: forceText(b), confirmLabel: 'Force push', arm: forceArm(b), danger: true }, origin))) return;
  await send(ctx, b, { lease: { oid } }, origin);
}
