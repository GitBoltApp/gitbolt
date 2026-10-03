import type { GraphPayload } from '../api/gen/GraphPayload';
import type { LocalBranch } from '../api/gen/LocalBranch';
import { isAncestorIn } from '../graph/ancestry';
import { findBase, type BaseRemote } from '../stacks/detect';

/** What `rewordableOlder` reads: the graph's rows, labels and HEAD, the sidebar's remotes (for
 * the trunk) and local branches (for HEAD's upstream). */
export interface RewordInput {
  graph: Pick<GraphPayload, 'rows' | 'labels' | 'head'>;
  indexById: ReadonlyMap<string, number>;
  remotes: readonly BaseRemote[];
  locals: readonly Pick<LocalBranch, 'fullName' | 'upstream'>[];
}

/** The trunk as the core's reword check has it (write/irebase/reword.rs `trunk`): origin/HEAD's
 * target, else the first of main, master, origin/main, origin/master; among the loaded refs. */
function trunkOf(g: RewordInput['graph'], remotes: readonly BaseRemote[]): string | null {
  const present = new Set<string>();
  for (const l of g.labels) {
    if (l.local) present.add(l.local);
    for (const r of l.remotes) present.add(r.fullName);
  }
  const head = remotes.find((r) => r.name === 'origin')?.defaultBranch;
  if (head && present.has(head)) return head;
  return ['refs/heads/main', 'refs/heads/master', 'refs/remotes/origin/main', 'refs/remotes/origin/master'].find((r) => present.has(r)) ?? null;
}

/**
 * 3C T13 (spec #3 §3.6): `id`, an older commit of HEAD's branch that "Edit message" rewords in
 * place; `null` when it isn't one. Not HEAD itself (that's 2D's amend), a merge (the brief's rule)
 * or the first commit (the core refuses it), and (fix 1 I1) not a commit the trunk has: rewording one
 * would copy trunk history into the branch. On the trunk itself, any ancestor of HEAD goes.
 * The trunk is the core's (`trunkOf`), so the pencil shows where the core allows it. `pushed`: HEAD's
 * upstream, when it already has the commit (the force-push note).
 */
export function rewordableOlder(input: RewordInput, id: string): { head: string; pushed: string | null } | null {
  const { graph: g, indexById } = input;
  const target = g.head.target;
  const branch = g.head.branch;
  if (!target || !branch || target === id) return null;
  const row = g.rows[indexById.get(id) ?? -1];
  if (!row || row.parents.length !== 1) return null;
  if (isAncestorIn(g.rows, indexById, id, target) !== true) return null;
  const trunk = trunkOf(g, input.remotes);
  const found = trunk ? findBase(g.labels, trunk) : null;
  if (trunk && found && branch !== trunk && branch !== `refs/heads/${found.name}`) {
    const tip = g.rows[found.row]?.id;
    if (tip && isAncestorIn(g.rows, indexById, id, tip) === true) return null;
  }
  const upstream = input.locals.find((l) => l.fullName === branch)?.upstream ?? null;
  const up = upstream ? findBase(g.labels, upstream) : null;
  const upTip = up ? g.rows[up.row]?.id : undefined;
  const pushed = upstream && upTip && isAncestorIn(g.rows, indexById, id, upTip) === true ? upstream.replace(/^refs\/remotes\//, '') : null;
  return { head: target, pushed };
}
