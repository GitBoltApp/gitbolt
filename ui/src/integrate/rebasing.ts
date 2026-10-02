import type { GraphPayload } from '../api/gen/GraphPayload';
import type { OpInfo } from '../app/ops';

/** `Rebasing main (23/60)…` (spec #2 §13.4): a rebase op, or a pull's rebase, with a step. The
 * status bar shows it from the first step (Deviation 11). */
export function rebaseStatus(op: OpInfo): string | null {
  if (!op.step || (op.kind !== 'rebase' && op.kind !== 'pull')) return null;
  return `Rebasing ${op.step.branch ? `${op.step.branch} ` : ''}(${op.step.n}/${op.step.m})…`;
}

/** The branch a rebase in `worktree` replays (its chip is drawn at HEAD, marked rebasing). */
export function rebasingChip(graph: Pick<GraphPayload, 'inProgress'>, worktree: string): string | null {
  const p = graph.inProgress?.[worktree];
  return p?.kind === 'rebase' ? p.headName.replace(/^refs\/heads\//, '') : null;
}
