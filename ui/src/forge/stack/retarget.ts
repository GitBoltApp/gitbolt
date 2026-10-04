import { Layers } from 'lucide-react';
import { api, errorMessage } from '../../api/client';
import type { ForgeKind } from '../../api/gen/ForgeKind';
import type { LocalBranch } from '../../api/gen/LocalBranch';
import { useRuntime } from '../../app/runtime';
import type { CommitTarget, MenuEnv } from '../../menu/menuEnv';
import type { MenuRow } from '../../menu/types';
import type { Stack } from '../../stacks/detect';
import { pushStack } from '../../stacks/push';
import { rebaseStack } from '../../stacks/rebase';
import { joinNames } from '../../stacks/text';
import { currentOrigin, type Origin } from '../../ui/arm/origin';
import { useToast, type ToastOptions } from '../../ui/toast';
import type { WriteCtx } from '../../write/client';
import { mrRef } from '../labels';
import { noteForgeWritten } from '../mrStore';
import { afterMerge, type AfterMerge, type StackEnv } from './chain';
import { notifyForgeWrite } from '../usePolling';
import type { ForgeTarget } from './deps';

const SKIP_WORDS = { busy: 'another fetch was running', authRequired: 'it needs your credentials' } as const;
const topOf = (a: AfterMerge) => a.branches[a.branches.length - 1];

/** What one click does (the menu row, the MR/PR view's Stack panel). */
export function afterMergeLabel(a: AfterMerge, kind: ForgeKind): string {
  return a.retarget ? `Retarget ${mrRef(kind, a.next.number)} and rebase the stack` : `Rebase the stack without the merged ${mrRef(kind, a.merged.number)}`;
}

/** Why it can't run now, as #3's Rebase stack says it (Ruling 10: 3C rebases the checked-out branch). */
export function afterMergeBlocked(a: AfterMerge, env: { headBranch: string | null; inProgress?: string | null; locals: readonly LocalBranch[]; worktreeShown(path: string): string }): string | undefined {
  if (env.inProgress) return `Finish or abort the ${env.inProgress} first`;
  const away = a.branches.map((n) => env.locals.find((b) => b.name === n)).find((b) => b?.worktree);
  if (away) return `${away.name} is checked out in ${env.worktreeShown(away.worktree!)}`;
  if (env.headBranch !== topOf(a)) return `Check out ${topOf(a)} first`;
  return undefined;
}

/** Where the stack goes: `<remote>/<branch>` when the graph has it, else the local branch. */
export function rebaseBase(tabId: string, remote: string, branch: string): string {
  const ref = `refs/remotes/${remote}/${branch}`;
  const sb = useRuntime.getState().tabs[tabId]?.sidebar;
  return sb?.remotes.some((g) => g.name === remote && g.branches.some((b) => b.fullName === ref)) ? ref : `refs/heads/${branch}`;
}

/**
 * "Retarget the next MR and rebase the stack" (spec #4 §4 4D, Ruling 8):
 * 1. retarget `next` through the API first (research §6: GitHub can close a PR whose base branch
 *    goes), unless the forge already did;
 * 2. fetch the target remote, when the stack goes onto a remote-tracking ref;
 * 3. #3's Rebase stack, dropping the merged commits (its confirm is the only one);
 * 4. #3's Push stack;
 * 5. the Stack tables (managed stacks; the core skips native ones).
 * Each failure stops the steps after it; the toast says what was done. One flow at a time per
 * merged MR/PR: a second click while one runs does nothing.
 */
export async function retargetAndRebase(ctx: WriteCtx, a: AfterMerge, target: ForgeTarget, origin: Origin | null = currentOrigin()): Promise<void> {
  const key = `${ctx.repoId}:${a.merged.number}`;
  if (running.has(key)) return;
  running.add(key);
  try {
    await flow(ctx, a, target, origin);
  } finally {
    running.delete(key);
  }
}

/** `${repoId}:${merged number}`: the after-merge flows running now. The row and the button stay
 * enabled (a disabled control can't take its armed confirm's second click): a click meanwhile does nothing. */
const running = new Set<string>();

async function flow(ctx: WriteCtx, a: AfterMerge, target: ForgeTarget, origin: Origin | null): Promise<void> {
  const show = (m: string, o?: ToastOptions) => useToast.getState().show(m, o);
  const next = mrRef(target.kind, a.next.number);
  if (a.retarget) {
    try {
      await api.forgeRetarget(ctx.repoId, a.next.number, a.target);
      noteForgeWritten(ctx.tabId); // a poll already under way may predate the new target
      notifyForgeWrite(ctx.tabId); // the poller refreshes the MR's target now: the row and a retry see it
    } catch (e) {
      show(`Couldn't retarget ${next} to ${a.target}: ${errorMessage(e)}`, { error: true });
      return;
    }
  }
  const did = a.retarget ? `Retargeted ${next} to ${a.target}` : null;
  const notRebased = did ? `${did}; the stack wasn't rebased` : "The stack wasn't rebased";
  const manual = afterMergeLabel({ ...a, retarget: false }, target.kind);
  const base = rebaseBase(ctx.tabId, target.remote, a.target);
  if (base.startsWith('refs/remotes/')) {
    try {
      const f = await api.fetch(ctx.repoId, false, target.remote);
      if (f.status !== 'done') {
        show(`${notRebased}: fetching ${target.remote} was skipped (${SKIP_WORDS[f.reason]})`, { error: true });
        return;
      }
    } catch (e) {
      show(`${notRebased}: fetching ${target.remote} failed (${errorMessage(e)})`, { error: true });
      return;
    }
  }
  const stack: Stack = { branches: a.branches, base, leftBehind: [] };
  // A merge-commit or fast-forward merge leaves the merged head in the base: nothing to drop. A squash doesn't.
  let headInBase = false;
  try {
    const head = a.merged.headSha;
    headInBase = !!head && (await api.mergeBase(ctx.repoId, head, base)) === head;
  } catch {
    headInBase = false;
  }
  const drop = !headInBase && a.dropFrom.length ? { from: a.dropFrom, branch: a.merged.sourceBranch } : null;
  const out = await rebaseStack(ctx, stack, { drop, origin });
  // Refused or failed: `rebaseStack` already toasted why, and that stays, with the retarget (a forge write) said under it.
  if (!out) {
    if (did) {
      const t = useToast.getState();
      if (t.message) show(t.message, { error: true, tone: t.tone ?? undefined, action: t.action ?? undefined, actions: t.actions, sticky: t.sticky, detail: [t.detail, `${did}.`].filter((x) => !!x).join(' ') });
      else show(notRebased, { error: true });
    }
    return;
  }
  // A cancel or the editor hand-off needs the way back.
  if (out.status === 'cancelled' || out.status === 'editor') {
    const way = headInBase ? 'Rebase stack' : manual;
    if (did) show(`${notRebased}. Use “${way}” on ${topOf(a)}`);
    return;
  }
  // A rebase that stopped (a conflict) or was aborted: #3's toast and the commit panel take over.
  if (out.status !== 'done' && out.status !== 'upToDate') return;
  // `rebaseStack`'s prepare already toasted an up-to-date stack: no second toast unless something happened before it.
  const upToDate = out.status === 'upToDate';
  // The rebase moved every branch: push from the refreshed snapshot, not the one from before it (it would see nothing to push).
  await useRuntime.getState().refresh(ctx.tabId);
  const pushed = await pushStack(ctx, stack);
  if (pushed.failed) return;
  // Push stack's server warnings (its own toast is replaced below) stay as detail lines.
  const lines = pushed.warnings.map((w) => `“${w}”`);
  try {
    const s = await api.forgeSyncStack(ctx.repoId, [a.merged.sourceBranch, ...a.branches], a.target);
    if (s.failed.length) lines.push(s.failed.map((f) => `Couldn't update the stack table in ${mrRef(target.kind, f.number)}: ${f.message}`).join(' '));
  } catch (e) {
    lines.push(`Couldn't update the stack tables: ${errorMessage(e)}`);
  }
  const opts: ToastOptions | undefined = lines.length ? { tone: 'warning', detail: lines.join(' '), sticky: pushed.warnings.length > 0 } : undefined;
  if (upToDate && !did && !opts) return;
  if (upToDate) {
    show(did ? `${did}; the stack was already on ${a.target}` : `The stack is already on ${a.target}`, opts);
    return;
  }
  show(did ? `${did}, then rebased and pushed the stack` : `Rebased the stack onto ${a.target} and pushed it`, opts);
}

/**
 * The after-merge action on a stack member's chip (Integrate group, after Rebase stack): shown
 * while `afterMerge` finds something to do, greyed as `afterMergeBlocked` says.
 */
export function afterMergeRow(t: CommitTarget, env: Pick<MenuEnv, 'sidebar' | 'inProgress' | 'headBranch' | 'worktreeShown'>, target: ForgeTarget | null, stackEnv: StackEnv | null, run: (a: AfterMerge) => void): MenuRow[] {
  const name = t.branch?.local?.replace(/^refs\/heads\//, '');
  const sb = env.sidebar;
  if (!name || !target || !sb || !stackEnv) return [];
  const a = afterMerge(name, stackEnv);
  if (!a) return [];
  const merged = mrRef(target.kind, a.merged.number);
  return [{
    kind: 'action', id: 'stack.forge.afterMerge', label: afterMergeLabel(a, target.kind), icon: Layers,
    tooltip: `${merged} was merged: ${a.retarget ? `point ${mrRef(target.kind, a.next.number)} at ${a.target}, ` : ''}rebase ${joinNames(a.branches)} onto ${a.target} without its commits, and push`,
    disabledReason: afterMergeBlocked(a, { headBranch: env.headBranch, inProgress: env.inProgress, locals: sb.locals, worktreeShown: env.worktreeShown }),
    run: () => run(a),
  }];
}
