// The range a rebase works on (plan 4): base..tip in git's topo order, ancestry, and the local
// branches in it (the core's integrate.rs `branch_sets`; 1b's `stackedBranches` reads its stacked
// set).
import { compareBytewise } from '../read/bytes';
import { readCommit } from '../read/commitText';
import { ancestors, refsUnder } from '../read/revs';
import type { ReadRepo } from '../read/seam';
import { listWorktrees } from '../read/worktrees';

export { shortRef } from '../writeSeam';
export { isAncestor, shortOid } from '../read/revs';

export interface RangeCommit { oid: string; parents: string[] }

/** Commits reachable from `tip` and not from `base`, children before parents, as `git log
 *  --topo-order` lists them (checked on the binary: commit dates don't change it). A depth-first
 *  walk that gives a commit once all its children in range are out, a merge's later parents'
 *  lines before its first parent's. `hidden`: `base`'s history when the caller has it (a view
 *  with no repository handle, an origin's, can't ask the graph for it). */
export async function rangeCommits(read: ReadRepo, tip: string, base: string, hidden?: Set<string>): Promise<RangeCommit[]> {
  hidden ??= await ancestors(read, base);
  const inRange = new Map<string, string[]>();
  const queue = [tip];
  while (queue.length > 0) {
    const at = queue.pop()!;
    if (hidden.has(at) || inRange.has(at)) continue;
    const parents = (await readCommit(read, at)).parents;
    inRange.set(at, parents);
    queue.push(...parents);
  }
  const children = new Map<string, number>();
  for (const parents of inRange.values()) for (const p of parents) if (inRange.has(p)) children.set(p, (children.get(p) ?? 0) + 1);
  const out: RangeCommit[] = [];
  const stack = inRange.has(tip) ? [tip] : [];
  while (stack.length > 0) {
    const at = stack.pop()!;
    const parents = inRange.get(at)!;
    out.push({ oid: at, parents });
    // The first parent goes on the stack first, so the merged-in line comes out before it.
    for (const p of parents) {
      if (!inRange.has(p)) continue;
      const left = children.get(p)! - 1;
      children.set(p, left);
      if (left === 0) stack.push(p);
    }
  }
  return out;
}

/** `tip`'s first-parent chain down to the first commit `hidden` holds (not included). */
export async function firstParentChain(read: ReadRepo, tip: string, hidden: Set<string>): Promise<Set<string>> {
  const chain = new Set<string>();
  for (let at: string | undefined = tip; at !== undefined && !hidden.has(at); at = (await readCommit(read, at)).parents[0]) chain.add(at);
  return chain;
}

/** The core's `branch_sets`: the local branches (full names, sorted) other than `branchFull` with
 *  tips in base..tip, by how tip reaches them: on its first-parent chain (stacked, which
 *  `--update-refs` moves along) or only through a merge's later parent (merged in). */
export async function branchSets(read: ReadRepo, branchFull: string, tip: string, base: string): Promise<{ stacked: [string, string][]; mergedIn: [string, string][] }> {
  const hidden = await ancestors(read, base);
  const range = await ancestors(read, tip);
  const chain = await firstParentChain(read, tip, hidden);
  const stacked: [string, string][] = [];
  const mergedIn: [string, string][] = [];
  // refsUnder lists them bytewise already.
  for (const h of await refsUnder(read, 'refs/heads')) {
    if (h.name === branchFull || hidden.has(h.oid) || !range.has(h.oid)) continue;
    (chain.has(h.oid) ? stacked : mergedIn).push([h.name, h.oid]);
  }
  const by = (a: [string, string], b: [string, string]) => compareBytewise(a[0], b[0]);
  return { stacked: stacked.sort(by), mergedIn: mergedIn.sort(by) };
}

/** Full branch name → the other worktree it's checked out in (`here`: this worktree's path). */
export async function branchesElsewhere(read: ReadRepo, here: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const w of await listWorktrees(read)) if (w.path !== here && w.branch) out.set(w.branch, w.path);
  return out;
}
