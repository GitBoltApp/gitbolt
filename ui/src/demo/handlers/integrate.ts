import type { StackedBranch } from '../../api/gen/StackedBranch';
import type { HandlerTable } from '../transport';
import { compareBytewise } from '../engine/read/bytes';
import { readCommit } from '../engine/read/commitText';
import { predictConflicts } from '../engine/read/merge3';
import { ancestors, configBool, refsUnder, relation, revParse } from '../engine/read/revs';
import { fail, readRepoOf, type ReadRepo } from '../engine/read/seam';
import { listWorktrees, worktreeOf } from '../engine/read/worktrees';

const HEADS = 'refs/heads/';

/** The core's `stacked_branches`: the local branches other than `branch` whose tips lie on its
 *  first-parent chain within `y..branch` (the ones `--update-refs` moves), by short name, each with
 *  the other worktree it's checked out in. `elsewhere`: full branch name → that worktree. */
export async function stackedBranches(repo: ReadRepo, branch: string, y: string, elsewhere: Map<string, string>): Promise<StackedBranch[]> {
  const full = `${HEADS}${branch}`;
  const heads = await refsUnder(repo, 'refs/heads');
  const tip = heads.find((h) => h.name === full)?.oid;
  if (!tip) return [];
  const hidden = await ancestors(repo, y);
  const chain = new Set<string>();
  for (let at: string | undefined = tip; at !== undefined && !hidden.has(at); at = (await readCommit(repo, at)).parents[0]) chain.add(at);
  return heads
    .filter((h) => h.name !== full && chain.has(h.oid))
    .map((h) => ({ name: h.name.slice(HEADS.length), worktree: elsewhere.get(h.name) ?? null }))
    .sort((a, b) => compareBytewise(a.name, b.name));
}

export const integrateHandlers: Pick<HandlerTable, 'integratePreview'> = {
  // integrate.rs's `preview`. `lossyMerge` stays null: the rebase plan fills it (plan 1b, Decisions).
  integratePreview: async ({ repo: id, worktree, kind, target }, ctx) => {
    const repo = readRepoOf(ctx, id);
    const here = await worktreeOf(repo, worktree);
    const elsewhere = new Map<string, string>();
    for (const w of await listWorktrees(repo)) if (w.path !== here.path && w.branch) elsewhere.set(w.branch, w.path);
    const head = here.head ?? fail('Other', `Branch '${here.branch ?? 'HEAD'}' does not have any commits`);
    const y = await revParse(repo, target, here.path);
    const [ahead, behind] = await relation(repo, head, y);
    const branch = here.branch?.startsWith(HEADS) ? here.branch.slice(HEADS.length) : null;
    const stacked = kind === 'rebase' && branch !== null ? await stackedBranches(repo, branch, y, elsewhere) : [];
    const updateRefsDefault = (await configBool(repo, 'rebase.updateRefs')) !== false;
    const conflicts = behind === 0 ? [] : await predictConflicts(repo, head, y);
    return { ahead, behind, merged: behind === 0, conflicts, stacked, updateRefsDefault, lossyMerge: null };
  },
};
