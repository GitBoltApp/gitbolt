import { FastForward, GitMerge, GitPullRequestArrow } from 'lucide-react';
import { api } from '../api/client';
import type { IntegrateKind } from '../api/gen/IntegrateKind';
import type { IntegrateOutcome } from '../api/gen/IntegrateOutcome';
import type { CommitTarget, MenuEnv } from '../menu/menuEnv';
import type { MenuRow } from '../menu/types';
import { askChoice } from '../ui/ChoiceDialog';
import { useToast } from '../ui/toast';
import { runWrite, type WriteCtx } from '../write/client';

const files = (n: number) => `${n} file${n === 1 ? '' : 's'}`;

/** What the Integrate rows call back (the menu wires them to the tab's write context). */
export interface IntegrateRun { ff(y: string): void; go(kind: IntegrateKind, y: string): void }

/**
 * The Integrate group for a branch label chip `Y`, with HEAD on `X` (spec #2 §13.1): Fast-forward Y
 * to X (Y local), Merge Y into X, Rebase X onto Y. Greyed with `busy` during another merge or
 * rebase. Ancestry and merged-ness are checked after the click (§14: menus stay synchronous).
 */
export function integrateRows(t: CommitTarget, env: Pick<MenuEnv, 'headBranch'>, busy: string | null, run: IntegrateRun = { ff: () => {}, go: () => {} }): MenuRow[] {
  const x = env.headBranch ?? 'HEAD';
  const y = t.branch;
  if (!y || y.name === x) return [];
  const local = y.local ? y.name : null;
  const target = local ?? y.remotes[0]?.fullName.replace(/^refs\/remotes\//, '') ?? y.name;
  const disabledReason = busy ?? undefined;
  const rows: MenuRow[] = [];
  if (local) rows.push({ kind: 'action', id: 'integrate.ff', label: `Fast-forward ${local} to ${x}`, icon: FastForward, tooltip: `Move ${local} up to ${x} (it must be behind ${x})`, run: () => run.ff(local), disabledReason });
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

/** Merge or rebase: the preview first; the confirmation shows only for predicted conflicts, a
 * stack (rebase) or a refused rebase (`lossyMerge`: the reason up front, Rebase greyed). */
export async function startIntegrate(ctx: WriteCtx, kind: IntegrateKind, target: string, x: string): Promise<void> {
  const p = await api.integratePreview(ctx.repoId, ctx.worktree, kind, target);
  if (kind === 'merge' && p.merged) return void useToast.getState().show(`${target} is already merged into ${x}`);
  const rebase = kind === 'rebase';
  const stacked = rebase && p.updateRefsSupported ? p.stacked : [];
  let updateRefs: boolean | undefined = rebase && p.updateRefsSupported ? p.updateRefsDefault : undefined;
  const refused = rebase ? p.lossyMerge : null;
  if (refused || p.conflicts.length > 0 || stacked.length > 0) {
    const verb = rebase ? `Rebasing ${x} onto ${target}` : `Merging ${target} into ${x}`;
    const away = stacked.filter((s) => s.worktree);
    const answer = await askChoice({
      title: rebase ? `Rebase ${x} onto ${target}?` : `Merge ${target} into ${x}?`,
      body: refused ?? (p.conflicts.length ? `${verb} will conflict in ${files(p.conflicts.length)}.` : `${verb}.`),
      note: refused || !away.length ? undefined : `${away.map((s) => `${s.name} is checked out in ${s.worktree}`).join('; ')}: git leaves it where it is.`,
      choices: [{ id: 'go', label: rebase ? 'Rebase' : 'Merge', primary: true, disabled: !!refused }],
      checkbox: stacked.length && !refused
        ? { label: `Also move ${stacked.length} stacked ${stacked.length === 1 ? 'branch' : 'branches'}`, checked: p.updateRefsDefault, detail: stacked.map((s) => s.name).join(', ') }
        : undefined,
    });
    if (refused || answer.choice !== 'go') return;
    if (stacked.length) updateRefs = answer.checked;
  }
  const out = await runWrite(ctx, (_, asked) => api.integrate(ctx.repoId, ctx.worktree, kind, target, { updateRefs, confirmAutostash: asked.autostash }));
  if (out) toastOutcome(out, kind, target, x);
}

/** "Fast-forward Y to X": git refuses a non-ancestor ("Y has commits X doesn't have"). */
export async function fastForward(ctx: WriteCtx, branch: string, to: string): Promise<void> {
  const out = await runWrite(ctx, () => api.fastForward(ctx.repoId, ctx.worktree, branch, to));
  if (!out) return;
  useToast.getState().show(out.status === 'upToDate' ? `${branch} is up to date` : `Fast-forwarded ${branch} to ${to}`);
}
