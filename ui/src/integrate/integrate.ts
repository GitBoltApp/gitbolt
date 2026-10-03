import { FastForward, GitMerge, GitPullRequestArrow } from 'lucide-react';
import { api } from '../api/client';
import type { IntegrateKind } from '../api/gen/IntegrateKind';
import type { IntegrateOutcome } from '../api/gen/IntegrateOutcome';
import type { CommitTarget, MenuEnv } from '../menu/menuEnv';
import type { MenuRow } from '../menu/types';
import { currentOrigin } from '../ui/arm/origin';
import { holdOrigin } from '../ui/arm/store';
import { askChoice } from '../ui/ChoiceDialog';
import { confirmAction } from '../ui/ConfirmDialog';
import { useToast } from '../ui/toast';
import { runWrite, type WriteCtx } from '../write/client';

const files = (n: number) => `${n} file${n === 1 ? '' : 's'}`;

/** What the Integrate rows call back (the menu wires them to the tab's write context). */
export interface IntegrateRun { ff(y: string): void; go(kind: IntegrateKind, y: string): void }

/**
 * The Integrate group for a branch label chip `Y`, with HEAD on `X` (spec #2 §13.1): Fast-forward Y
 * to X (Y local), Merge Y into X, Rebase X onto Y. Only what can apply shows: from the loaded
 * rows, a `Y` already in `X`'s history gets only the fast-forward (merging it or rebasing onto
 * it is a no-op), and any other `Y` only the merge and the rebase (it isn't behind `X`); a `Y`
 * checked out in a worktree can't be fast-forwarded. When the rows can't tell (a commit not
 * loaded), all three show and the backend checks after the click (§14: menus stay synchronous).
 * Greyed with `busy` during another merge or rebase, or on a detached HEAD.
 */
export function integrateRows(t: CommitTarget, env: Pick<MenuEnv, 'headBranch'> & Partial<Pick<MenuEnv, 'headSha' | 'isAncestor' | 'sidebar'>>, busy: string | null, run: IntegrateRun = { ff: () => {}, go: () => {} }): MenuRow[] {
  const x = env.headBranch ?? 'HEAD';
  const y = t.branch;
  if (!y || y.name === x) return [];
  const local = y.local ? y.name : null;
  const target = local ?? y.remotes[0]?.fullName.replace(/^refs\/remotes\//, '') ?? y.name;
  const disabledReason = busy ?? undefined;
  // Y's tip in X's history (true), not (false), or unknown (null).
  const inX = env.headSha ? env.isAncestor?.(t.sha, env.headSha) ?? null : null;
  const checkedOut = !!y.local && !!env.sidebar?.locals.find((b) => b.fullName === y.local)?.checkedOut;
  const rows: MenuRow[] = [];
  if (local && inX !== false && t.sha !== env.headSha && !checkedOut) rows.push({ kind: 'action', id: 'integrate.ff', label: `Fast-forward ${local} to ${x}`, icon: FastForward, tooltip: `Move ${local} up to ${x}`, run: () => run.ff(local), disabledReason });
  if (inX === true) return rows;
  rows.push({ kind: 'action', id: 'integrate.merge', label: `Merge ${target} into ${x}`, icon: GitMerge, tooltip: `git merge ${target} on ${x}`, run: () => run.go('merge', target), disabledReason });
  rows.push({ kind: 'action', id: 'integrate.rebase', label: `Rebase ${x} onto ${target}`, icon: GitPullRequestArrow, tooltip: `git rebase ${target} on ${x}`, run: () => run.go('rebase', target), disabledReason });
  return rows;
}

function toastOutcome(o: IntegrateOutcome, kind: IntegrateKind, target: string, x: string): void {
  const show = (m: string) => useToast.getState().show(m);
  if (o.status === 'upToDate') return show(kind === 'merge' ? `${target} is already merged into ${x}` : `${x} is up to date`);
  if (o.status !== 'done') return; // stopped: the banner takes over (§13.2); aborted: nothing to say
  if (o.fastForward) return show(`Fast-forwarded ${x} to ${target}`);
  show(kind === 'merge' ? `Merged ${target} into ${x}` : `Rebased ${x} onto ${target}`);
}

/** Merge or rebase: the preview first; it asks only for predicted conflicts, a stack (rebase) or
 * a refused rebase. Predicted conflicts arm the clicked row in place, its menu held open while
 * the preview runs (spec §ui confirms, board A); a stack is a real choice (move the stacked
 * branches or not) and a refused rebase says why: the anchored popover (board G). */
export async function startIntegrate(ctx: WriteCtx, kind: IntegrateKind, target: string, x: string): Promise<void> {
  const origin = currentOrigin();
  const release = holdOrigin();
  const rebase = kind === 'rebase';
  let updateRefs: boolean | undefined;
  try {
    const p = await api.integratePreview(ctx.repoId, ctx.worktree, kind, target);
    if (kind === 'merge' && p.merged) {
      release();
      return void useToast.getState().show(`${target} is already merged into ${x}`);
    }
    const stacked = rebase && p.updateRefsSupported ? p.stacked : [];
    updateRefs = rebase && p.updateRefsSupported ? p.updateRefsDefault : undefined;
    const refused = rebase ? p.lossyMerge : null;
    const verb = rebase ? `Rebasing ${x} onto ${target}` : `Merging ${target} into ${x}`;
    const conflicts = p.conflicts.length ? `${verb} will conflict in ${files(p.conflicts.length)}.` : null;
    if (refused || stacked.length > 0) {
      release();
      const away = stacked.filter((s) => s.worktree);
      const answer = await askChoice({
        title: rebase ? `Rebase ${x} onto ${target}?` : `Merge ${target} into ${x}?`,
        body: refused ?? conflicts ?? `${verb}.`,
        note: refused || !away.length ? undefined : `${away.map((s) => `${s.name} is checked out in ${s.worktree}`).join('; ')}: git leaves it where it is.`,
        choices: [{ id: 'go', label: rebase ? 'Rebase' : 'Merge', primary: true, disabled: !!refused }],
        checkbox: stacked.length && !refused
          ? { label: `Also move ${stacked.length} stacked ${stacked.length === 1 ? 'branch' : 'branches'}`, checked: p.updateRefsDefault, detail: stacked.map((s) => s.name).join(', ') }
          : undefined,
      }, origin);
      if (refused || answer.choice !== 'go') return;
      if (stacked.length) updateRefs = answer.checked;
    } else if (conflicts) {
      const n = files(p.conflicts.length);
      const replayed = rebase && p.ahead ? `${p.ahead} ${p.ahead === 1 ? 'commit' : 'commits'}, ` : '';
      // Armed first, then the hold goes: the row stays armed in its open menu.
      const asked = confirmAction({
        title: rebase ? `Rebase ${x} onto ${target}?` : `Merge ${target} into ${x}?`,
        body: conflicts,
        confirmLabel: rebase ? 'Rebase' : 'Merge',
        arm: rebase ? `Click again to rebase onto ${target} (${replayed}conflicts in ${n})` : `Click again to merge ${target} (conflicts in ${n})`,
        caption: conflicts,
        tone: 'warn',
      }, origin);
      release();
      if (!(await asked)) return;
    } else release();
  } finally {
    release();
  }
  const out = await runWrite(ctx, (_, asked) => api.integrate(ctx.repoId, ctx.worktree, kind, target, { updateRefs, confirmAutostash: asked.autostash }), { origin });
  if (out) toastOutcome(out, kind, target, x);
}

/** "Fast-forward Y to X": git refuses a non-ancestor ("Y has commits X doesn't have"). */
export async function fastForward(ctx: WriteCtx, branch: string, to: string): Promise<void> {
  const out = await runWrite(ctx, () => api.fastForward(ctx.repoId, ctx.worktree, branch, to));
  if (!out) return;
  useToast.getState().show(out.status === 'upToDate' ? `${branch} is up to date` : `Fast-forwarded ${branch} to ${to}`);
}
