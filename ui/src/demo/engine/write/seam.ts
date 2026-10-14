// The write layer's view of one worktree: its repository (1b's read view and 1a's DemoRepo), its
// root, and its own git dir. HEAD, the index and the merge files live in the worktree's own git
// dir (`.git/worktrees/<id>` for a linked one); refs, objects and config in the common one
// (`demo.gitdir`).
import type { DemoContext } from '../../context';
import type { MemFs } from '../memfs';
import { demoOf, readRepoOf, type ReadRepo } from '../read/seam';
import { worktreeOf } from '../read/worktrees';
import type { DemoRepo } from '../repo';

export interface WriteWt {
  readonly repo: ReadRepo;
  readonly demo: DemoRepo;
  readonly fs: MemFs;
  /** The worktree's root (the demo's paths are canonical already). */
  readonly root: string;
  /** Its own git dir. */
  readonly gitdir: string;
  readonly isMain: boolean;
}

/** The worktree `worktree` of the open repository `repoId`: InvalidInput "<path> is not a worktree
 *  of this repository" otherwise (1b's `worktreeOf`, the core's `worktree_dir`). */
export async function writeTarget(ctx: DemoContext, repoId: number, worktree: string): Promise<WriteWt> {
  const repo = readRepoOf(ctx, repoId);
  const w = await worktreeOf(repo, worktree);
  const demo = demoOf(repo);
  return { repo, demo, fs: demo.fs, root: w.path, gitdir: w.gitdir, isMain: w.isMain };
}

/** The main worktree of a repository a test built (1b's testkit). */
export function mainWt(repo: ReadRepo): WriteWt {
  const demo = demoOf(repo);
  return { repo, demo, fs: demo.fs, root: repo.dir, gitdir: repo.gitdir, isMain: true };
}
