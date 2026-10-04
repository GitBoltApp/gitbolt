// ui/src/stacks/rebase.ts
import { GitPullRequestArrow } from 'lucide-react';
import { api, errorMessage } from '../api/client';
import type { ChipPlan } from '../api/gen/ChipPlan';
import type { IntegrateOutcome } from '../api/gen/IntegrateOutcome';
import type { RebasePlanPayload } from '../api/gen/RebasePlanPayload';
import type { RebaseRow } from '../api/gen/RebaseRow';
import { openRebaseEditor } from '../irebase/open';
import type { CommitTarget, MenuEnv } from '../menu/menuEnv';
import type { MenuRow } from '../menu/types';
import { currentOrigin, type Origin } from '../ui/arm/origin';
import { holdOrigin } from '../ui/arm/store';
import { askChoice } from '../ui/ChoiceDialog';
import { confirmWith } from '../ui/ConfirmDialog';
import { useToast } from '../ui/toast';
import { runWrite, type WriteCtx } from '../write/client';
import type { Stack } from './detect';
import { joinNames, shortRef } from './text';
import { toastRebaseOutcome } from '../irebase/outcome';

/** What Rebase stack sends as 3C's InteractiveRebase (its client's `req`, before the autostash answer). */
export interface StackPlan { branch: string; base: string; expect: Record<string, string>; rows: RebaseRow[]; chips: ChipPlan[] }

/** 4D: a merged bottom's commits to drop (Ruling 9): every row at or below `from`; `branch` names it in the confirm. */
export interface Drop { from: string[]; branch: string }

/** The plan row index of the first drop candidate the plan holds, else -1 (rows are newest first). */
export function dropCut(plan: RebasePlanPayload, drop: Drop | null): number {
  if (!drop) return -1;
  for (const oid of drop.from) {
    const i = plan.rows.findIndex((r) => r.oid === oid);
    if (i >= 0) return i;
  }
  return -1;
}

const top = (s: Stack) => s.branches[s.branches.length - 1];
const commits = (n: number) => `${n} ${n === 1 ? 'commit' : 'commits'}`;

/**
 * Rebase stack as 3C's InteractiveRebase (spec #3 §3.11, §3.3), from 3C's RebasePlan for the top:
 * - every row Pick, except rows already in the base under another id (`upstream`): Drop, as git's
 *   own todo leaves them out;
 * - every chip of the plan is sent (3C refuses a plan that leaves one out): a lower member whose
 *   tip row, or a row below it, is still replayed moves with its row (`update-ref`; 3C puts a
 *   chip on a dropped row after the group below it); a member with nothing replayed (already in
 *   the base, Review Focus 1) and a branch that isn't a member (Ruling 4) `stay`; git moves the
 *   top itself;
 * - the plan's expected tips (CAS, §5), as the plan gives them: the base ref's is its unpeeled
 *   target (an annotated tag's own object, 3C's `Range.base_ref_target`), never the base's oid.
 * Not recognised as upstream: a squash-merged multi-commit bottom (the cherry-mark patch-ids differ
 * from the squash's), so its rows are replayed.
 * 4D: `drop` also drops a merged bottom's rows (a squash merge isn't upstream).
 * Pure. The core's run.rs `--- 3D T4 ---` tests compose the same requests.
 */
export function stackPlan(stack: Stack, plan: RebasePlanPayload, drop: Drop | null = null): StackPlan {
  const lower = new Set(stack.branches.slice(0, -1));
  const index = new Map(plan.rows.map((r, i) => [r.oid, i]));
  // 4D: rows at or below the merged bottom's tip go (rows are newest first).
  const cut = dropCut(plan, drop);
  const goes = (i: number) => plan.rows[i].upstream || (cut >= 0 && i >= cut);
  const replayed = (at: string) => {
    const i = index.get(at);
    return i !== undefined && plan.rows.some((_, k) => k >= i && !goes(k));
  };
  return {
    branch: top(stack),
    base: stack.base,
    expect: plan.expect,
    rows: plan.rows.map((r, i) => ({ oid: r.oid, action: goes(i) ? ('drop' as const) : ('pick' as const) })),
    chips: plan.chips.map((c): ChipPlan => ({ branch: c.branch, at: lower.has(c.branch) && replayed(c.at) ? { kind: 'row', oid: c.at } : { kind: 'stay' } })),
  };
}

/** The chips that move with their row. */
const rowChips = (p: StackPlan) => p.chips.filter((c) => c.at.kind === 'row');

/**
 * The armed row's label and caption, from the plan `stackPlan` made: what moves, what conflicts,
 * what stays behind. A lower member sent as `stay` is already in the base; one the plan has no
 * chip for at all (the graph's stack is stale) just stays where it is.
 */
export function rebaseConfirm(stack: Stack, req: StackPlan, conflicting: number, dropped = 0, drop: Drop | null = null, dropMissing = false): { arm: string; caption?: string; tone: 'warn' | 'positive' } {
  const base = shortRef(stack.base);
  const at = new Map(req.chips.map((c) => [c.branch, c.at.kind]));
  const lower = stack.branches.slice(0, -1);
  const inBase = lower.filter((n) => at.get(n) === 'stay');
  const unplanned = lower.filter((n) => !at.has(n));
  const moving = stack.branches.length - inBase.length - unplanned.length;
  const what = `${moving} ${moving === 1 ? 'branch' : 'branches'}`;
  const one = (names: string[]) => names.length === 1;
  const members = new Set(stack.branches);
  const others = req.chips.filter((c) => c.at.kind === 'stay' && !members.has(c.branch) && c.branch !== drop?.branch).map((c) => c.branch);
  const shown = others.length > 2 ? `${others.slice(0, 2).join(', ')} +${others.length - 2} more` : joinNames(others);
  const notes = [
    drop && dropMissing ? `The merged commits of ${drop.branch} weren't found in the stack: they'll be replayed (resolve or drop them in the editor).` : null,
    drop && dropped ? `${commits(dropped)} of ${drop.branch} (merged) ${dropped === 1 ? 'is' : 'are'} dropped.` : null,
    conflicting ? `${commits(conflicting)} will conflict.` : null,
    inBase.length ? `${joinNames(inBase)} ${one(inBase) ? 'is' : 'are'} already in ${base} and ${one(inBase) ? 'stays where it is' : 'stay where they are'}.` : null,
    unplanned.length ? `${joinNames(unplanned)} ${one(unplanned) ? 'stays where it is' : 'stay where they are'}.` : null,
    others.length ? `${shown} ${one(others) ? 'stays where it is' : 'stay where they are'}.` : null,
    stack.leftBehind.length ? `${joinNames(stack.leftBehind)} ${one(stack.leftBehind) ? 'stays' : 'stay'} on the old commits.` : null,
  ].filter((n) => n !== null);
  return {
    arm: `Click again to rebase ${what} onto ${base}${conflicting ? ` (conflicts at ${commits(conflicting)})` : ''}`,
    caption: notes.length ? notes.join(' ') : undefined,
    tone: conflicting ? 'warn' : 'positive',
  };
}

/** The read, the refusals and the confirm. The plan to send; `upToDate`; `cancelled` (not confirmed); `editor` (merges: the editor was offered); or `null` (refused or failed, already toasted). */
async function prepare(ctx: WriteCtx, stack: Stack, origin: Origin | null, release: () => void, drop: Drop | null): Promise<StackPlan | 'upToDate' | 'cancelled' | 'editor' | null> {
  const base = shortRef(stack.base);
  const show = (m: string, error = false) => useToast.getState().show(m, { error });
  let plan: RebasePlanPayload;
  try {
    plan = await api.rebasePlan(ctx.repoId, ctx.worktree, top(stack), stack.base);
  } catch (e) {
    release();
    show(errorMessage(e), true);
    return null;
  }
  if (plan.merges > 0) {
    // Ruling 6: never flatten without the editor's warning (§3.6's wording).
    release();
    const n = plan.merges;
    const answer = await askChoice({ title: `Rebase the stack onto ${base}?`, body: `This would flatten ${n} merge ${n === 1 ? 'commit' : 'commits'}: use the interactive rebase editor.`, choices: [{ id: 'editor', label: 'Open the editor', primary: true }] }, origin);
    // 4D: the merged bottom's rows open as Drop, as the stack plan would have sent them.
    const cut = dropCut(plan, drop);
    const preset = cut >= 0 ? { rows: Object.fromEntries(plan.rows.slice(cut).map((r) => [r.oid, 'drop' as const])) } : undefined;
    if (answer.choice === 'editor') void openRebaseEditor(ctx.tabId, { branch: top(stack), base: stack.base, ...(preset ? { preset } : {}) });
    return 'editor';
  }
  const req = stackPlan(stack, plan, drop);
  // 4D: rows the drop takes that git wouldn't: a branch still carrying them isn't on the base yet.
  const dropped = req.rows.filter((r, i) => r.action === 'drop' && !plan.rows[i].upstream).length;
  if (!dropped && plan.rows.every((r) => r.upstream)) { release(); show(`${top(stack)} is already in ${base}`); return 'upToDate'; }
  if (!dropped && plan.behind === 0) { release(); show(`The stack is already on ${base}`); return 'upToDate'; }
  // A hint only (§3.2, §5): off, failed or slow, the confirm just doesn't count conflicts.
  const p = await api.predictRebase(ctx.repoId, ctx.worktree, stack.base, req.rows).catch(() => null);
  const conflicting = p && !p.off ? p.rows.filter((r) => r.conflicts.length > 0).length : 0;
  const c = rebaseConfirm(stack, req, conflicting, dropped, drop, !!drop && dropCut(plan, drop) < 0);
  // Armed first, then the hold goes: the row stays armed in its open menu (as 2D's stacked rebase).
  const asked = confirmWith({ title: `Rebase the stack onto ${base}?`, body: c.caption, confirmLabel: 'Rebase', arm: c.arm, caption: c.caption, tone: c.tone }, origin);
  release();
  return (await asked).ok ? req : 'cancelled';
}

/** The toast for a finished Rebase stack; a `warning` (something after it didn't complete) shows as one. */
function toastOutcome(out: IntegrateOutcome, req: StackPlan, base: string): void {
  // Stopped: the commit panel takes over (§4.1); UX F: one without a conflict says why (the signer).
  if (out.status === 'stopped') return toastRebaseOutcome(out);
  if (out.status !== 'done' && out.status !== 'upToDate') return;
  const message = out.status === 'done' ? `Rebased ${rowChips(req).length + 1} branches onto ${base}` : `The stack is already on ${base}`;
  useToast.getState().show(message, out.warning ? { tone: 'warning', detail: out.warning } : undefined);
}

/** "Rebase stack onto <base>" (spec #3 §3.11): one InteractiveRebase moving every member; one Undo restores them all (§3.4).
 * 4D: `drop` drops a merged bottom's commits; `origin` where the action started (the after-merge flow captures it before its
 * own awaits). Resolves the outcome (`upToDate` when the stack already sits on the base), `{ status: 'cancelled' }` (the user declined the confirm), `{ status: 'editor' }` (merges: handed to the editor
 * or the choice dismissed), or `null`: refused or failed (already toasted). */
export async function rebaseStack(ctx: WriteCtx, stack: Stack, opts: { drop?: Drop | null; origin?: Origin | null } = {}): Promise<IntegrateOutcome | { status: 'cancelled' | 'editor' } | null> {
  // Captured before the first await: the menu row's origin carries through to the write's questions.
  const origin = opts.origin === undefined ? currentOrigin() : opts.origin;
  const release = holdOrigin();
  const req = await prepare(ctx, stack, origin, release, opts.drop ?? null).finally(release);
  if (req === 'upToDate') return { status: 'upToDate' };
  if (req === 'cancelled' || req === 'editor') return { status: req };
  if (!req) return null;
  const out = await runWrite(ctx, (_confirmed, asked) => api.interactiveRebase(ctx.repoId, ctx.worktree, { ...req, confirmAutostash: asked.autostash }), { origin });
  if (out) toastOutcome(out, req, shortRef(stack.base));
  return out;
}

/** A ref's tip from the sidebar snapshot (local or remote-tracking). */
function tipOf(sb: MenuEnv['sidebar'], ref: string): string | undefined {
  if (ref.startsWith('refs/heads/')) return sb?.locals.find((b) => b.fullName === ref)?.target;
  return sb?.remotes.flatMap((g) => g.branches).find((r) => r.fullName === ref)?.target;
}

/**
 * "Rebase stack onto <base>" on any member's chip (spec #3 §4.3), in the Integrate group. Hidden
 * when the stack already sits on the base (from the loaded ancestry). Greyed during another
 * operation, while a member is checked out in another worktree (git can't move it, §3.3), or while
 * HEAD isn't the top ("Check out <Bn> first", §3.11: 3C's intent rebases the checked-out branch).
 */
export function rebaseStackRow(t: CommitTarget, env: Pick<MenuEnv, 'stackOf' | 'sidebar' | 'inProgress' | 'isAncestor' | 'worktreeShown' | 'headBranch'>, run: (s: Stack) => void): MenuRow[] {
  const name = t.branch?.local?.replace(/^refs\/heads\//, '');
  const stack = name ? env.stackOf?.(name) ?? null : null;
  if (!stack) return [];
  const sb = env.sidebar;
  const base = shortRef(stack.base);
  const baseTip = tipOf(sb, stack.base);
  const bottom = tipOf(sb, `refs/heads/${stack.branches[0]}`);
  if (baseTip && bottom && env.isAncestor?.(baseTip, bottom) === true) return [];
  const away = stack.branches.map((n) => sb?.locals.find((b) => b.name === n)).find((b) => b?.worktree);
  const disabledReason = env.inProgress
    ? `Finish or abort the ${env.inProgress} first`
    : stack.partial
      ? 'Load more history first'
    : away
      ? `${away.name} is checked out in ${env.worktreeShown(away.worktree!)}`
      : env.headBranch !== top(stack)
        ? `Check out ${top(stack)} first`
        : undefined;
  return [{
    kind: 'action', id: 'stack.rebase', label: `Rebase stack onto ${base}`, icon: GitPullRequestArrow,
    tooltip: `Rebase ${stack.branches.join(' → ')} onto ${base}, moving every branch`,
    disabledReason, run: () => run(stack),
  }];
}
