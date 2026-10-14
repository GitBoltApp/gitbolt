import type { StackedBranch } from '../../api/gen/StackedBranch';
import type { HandlerTable } from '../transport';
import { compareBytewise } from '../engine/read/bytes';
import { predictConflicts } from '../engine/read/merge3';
import { configBool, refsUnder, relation, revParse } from '../engine/read/revs';
import { fail, readRepoOf, type ReadRepo } from '../engine/read/seam';
import { worktreeOf } from '../engine/read/worktrees';
import { branchesElsewhere, branchSets } from '../engine/seq/range';
import { lossyMerge, lossyMessage } from '../engine/seq/rebase';

const HEADS = 'refs/heads/';

/** The core's `stacked_branches`: the local branches other than `branch` whose tips lie on its
 *  first-parent chain within `y..branch` (the ones `--update-refs` moves), by short name, each with
 *  the other worktree it's checked out in. `elsewhere`: full branch name → that worktree. */
export async function stackedBranches(repo: ReadRepo, branch: string, y: string, elsewhere: Map<string, string>): Promise<StackedBranch[]> {
  const full = `${HEADS}${branch}`;
  const tip = (await refsUnder(repo, 'refs/heads')).find((h) => h.name === full)?.oid;
  if (!tip) return [];
  return (await branchSets(repo, full, tip, y)).stacked
    .map(([name]) => ({ name: name.slice(HEADS.length), worktree: elsewhere.get(name) ?? null }))
    .sort((a, b) => compareBytewise(a.name, b.name));
}

export const integrateHandlers: Pick<HandlerTable, 'integratePreview'> = {
  // integrate.rs's `preview`.
  integratePreview: async ({ repo: id, worktree, kind, target }, ctx) => {
    const repo = readRepoOf(ctx, id);
    const here = await worktreeOf(repo, worktree);
    const elsewhere = await branchesElsewhere(repo, here.path);
    const head = here.head ?? fail('Other', `Branch '${here.branch ?? 'HEAD'}' does not have any commits`);
    const y = await revParse(repo, target, here.path);
    const [ahead, behind] = await relation(repo, head, y);
    const branch = here.branch?.startsWith(HEADS) ? here.branch.slice(HEADS.length) : null;
    const stacked = kind === 'rebase' && branch !== null ? await stackedBranches(repo, branch, y, elsewhere) : [];
    const updateRefsDefault = (await configBool(repo, 'rebase.updateRefs')) !== false;
    const conflicts = behind === 0 ? [] : await predictConflicts(repo, head, y);
    const lossy = kind === 'rebase' && branch !== null ? await lossyMerge(repo, head, y) : null;
    return { ahead, behind, merged: behind === 0, conflicts, stacked, updateRefsDefault, lossyMerge: lossy === null ? null : lossyMessage(branch!, lossy, target) };
  },
};
