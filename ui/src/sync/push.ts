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
import { useToast, type ToastAction } from '../ui/toast';
import { runOnce, withPending } from '../pending/store';
import { runWrite, type WriteCtx } from '../write/client';
import { askPushTarget } from './PushUpstreamPanel';
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

/** The force confirmation's body (spec #2 §12.3; the title asks "Force push main to
 * origin/main?"): what the push replaces, counted from the snapshot. */
export function forceText(b: LocalBranch): string {
  const n = b.pushBehind ?? 0;
  if (n === 0) return `It may replace commits on the server that aren't in ${b.name}. A push can't be undone.`;
  const what = n === 1 ? `1 commit on ${b.pushTarget} that isn't in ${b.name}` : `${n} commits on ${b.pushTarget} that aren't in ${b.name}`;
  return `It replaces ${what}. A push can't be undone.`;
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
export const pushHooks: {
  pull: ((ctx: WriteCtx, branch: string) => void) | null;
  // --- 4C T9 ---
  /** 4C sets it: the push toast's "Create MR" for a branch the push created on `remote`. */
  afterNewBranch: ((tabId: string, branch: string, remote: string) => ToastAction | null) | null;
  // --- end 4C T9 ---
} = { pull: null, afterNewBranch: null };

// --- 4C T9 ---
/** The push toast's extra links (ruling 15): `afterNewBranch`'s, when this push created the
 * remote branch (no push target before it, or its remote ref didn't exist) and sent something. */
export function afterPushActions(tabId: string, b: LocalBranch, upToDate: boolean, remote: string): ToastAction[] {
  const created = !b.pushTarget || b.pushBehind === null;
  const link = created && !upToDate ? pushHooks.afterNewBranch?.(tabId, b.name, remote) : null;
  return link ? [link] : [];
}
// --- end 4C T9 ---

/** A rejected push is a real choice (spec §ui confirms, board G): a popover anchored at the Push
 * that started it, "origin/main has 1 commit main doesn't have", with [Cancel] [Force push…]
 * [Pull]: the safe Pull right-most and focused, Force push (with lease) red, arming in place
 * before it goes; Details is a link in the body. */
async function rejected(ctx: WriteCtx, b: LocalBranch, err: GbError, target: string, origin: Origin | null): Promise<void> {
  const pull = pushHooks.pull;
  const now = branchOf(ctx.tabId, b.name) ?? b;
  // The lease is read with the count the armed label shows, before the question: they agree.
  const lease = leaseOf(ctx.tabId, now);
  const n = now.pushBehind ?? 0;
  const answer = await askChoice({
    title: `${target} has ${n > 0 ? `${n} ${n === 1 ? 'commit' : 'commits'}` : 'commits'} ${b.name} doesn't have`,
    body: pull ? 'Pull them in first, or overwrite them.' : 'Overwrite them with a force push?',
    choices: [
      ...(pull ? [{ id: 'pull', label: 'Pull', primary: true }] : []),
      ...(b.pushTarget ? [{ id: 'force', label: 'Force push…', danger: true, arm: forceArm(now) }] : []),
      { id: 'details', label: 'Details', quiet: true },
    ],
  }, origin);
  if (answer.choice === 'pull') pull?.(ctx, b.name);
  else if (answer.choice === 'force') await forcePush(ctx, now, { oid: lease, origin });
  else if (answer.choice === 'details') openDebug('commands', err.commandId ?? null);
}

async function send(ctx: WriteCtx, b: LocalBranch, opts: { target?: PushTarget; setUpstream?: boolean; lease?: { oid: string | null } }, origin: Origin | null = currentOrigin()): Promise<void> {
  const shown = opts.target ? `${opts.target.remote}/${opts.target.branch}` : (b.pushTarget ?? b.name);
  // The rejection's question runs once this push has ended (its Force push is a push of the same branch).
  let rejection: GbError | null = null;
  await runOnce(ctx.tabId, 'push', b.fullName, () => withPending(ctx.tabId, [b.fullName], 'push', () => runWrite(ctx, () => api.push(ctx.repoId, ctx.worktree, b.name, { ...opts, expect: { head: null, refs: { [b.fullName]: b.target } } }), {
    onSuccess: (o) => {
      const dst = `${o.remote}/${o.dst}`;
      // A rewrite mark's lease held (spec #2 §12.3): say it was forced, and why.
      const done = o.forced ? `Force-pushed ${o.branch} (with lease): it was ${REWROTE[o.forced]}` : `Pushed ${o.branch} to ${dst}`;
      showServerResult(o.upToDate ? `${dst} is up to date` : done, `${done}; the server reported a problem`, o.server, o.op, afterPushActions(ctx.tabId, b, o.upToDate, o.remote));
    },
    handle: (err) => {
      if (err.kind !== 'NonFastForward') return false;
      rejection = err;
      return true;
    },
    origin,
  })));
  if (rejection) void rejected(ctx, b, rejection, shown, origin);
}

/** Push: to the branch's target; with none, asks where (and tracks it). */
export async function pushBranch(ctx: WriteCtx, b: LocalBranch): Promise<void> {
  if (!b.pushTarget) return openPushUpstream(ctx, b);
  return send(ctx, b, {});
}

/** "Push main to [origin ▾] / [main]", ☑ Track it: the panel under the Push that started it. */
export async function openPushUpstream(ctx: WriteCtx, b: LocalBranch): Promise<void> {
  const origin = currentOrigin();
  const remotes = (useRuntime.getState().tabs[ctx.tabId]?.sidebar?.remotes ?? []).map((g) => g.name);
  if (remotes.length === 0) {
    useToast.getState().show(`${b.name} has no upstream and this repository has no remote`, { error: true });
    return;
  }
  const answer = await askPushTarget(b.name, remotes, origin);
  if (answer) await send(ctx, b, { target: answer.target, setUpstream: answer.track }, origin);
}

/** Force push with a lease on the remote-tracking oid shown now, after a confirmation (it arms
 * in place). `confirmed`: it already did, in the rejection's popover, with this lease (read when
 * that question showed its count) and the origin the push started from. */
export async function forcePush(ctx: WriteCtx, b: LocalBranch, confirmed?: { oid: string | null; origin: Origin | null }): Promise<void> {
  if (!b.pushTarget) return;
  const origin = confirmed ? confirmed.origin : currentOrigin();
  const oid = confirmed ? confirmed.oid : leaseOf(ctx.tabId, b);
  if (!confirmed && !(await confirmAction({ title: `Force push ${b.name} to ${b.pushTarget}?`, body: forceText(b), confirmLabel: 'Force push', arm: forceArm(b), danger: true }, origin))) return;
  await send(ctx, b, { lease: { oid } }, origin);
}
