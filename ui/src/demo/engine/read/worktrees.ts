import { demoOf, fail, readTextOrNull, type ReadRepo } from './seam';

export interface DemoWorktree {
  path: string;
  /** Its own git dir: the common one for the main worktree, `.git/worktrees/<id>` for a linked one. */
  gitdir: string;
  isMain: boolean;
  /** HEAD's commit; null when unborn. */
  head: string | null;
  /** HEAD's branch as a full ref; null when detached. */
  branch: string | null;
}

/** 1a's `DemoRepo.worktrees()` (the core's `worktree list`, main first) without the bare and prunable
 *  ones, each with its git dir: a linked worktree's `.git` file names it. */
export async function listWorktrees(repo: ReadRepo): Promise<DemoWorktree[]> {
  const out: DemoWorktree[] = [];
  for (const w of await demoOf(repo).worktrees()) {
    if (w.bare || w.prunable) continue;
    let gitdir = repo.gitdir;
    if (!w.isMain) {
      const text = (await readTextOrNull(repo, `${w.path}/.git`))?.trim() ?? '';
      if (!text.startsWith('gitdir:')) continue;
      gitdir = text.slice('gitdir:'.length).trim();
    }
    out.push({ path: w.path, gitdir, isMain: w.isMain, head: w.head, branch: w.branch });
  }
  return out;
}

export async function worktreeOf(repo: ReadRepo, worktree: string): Promise<DemoWorktree> {
  const want = worktree.length > 1 ? worktree.replace(/\/+$/, '') : worktree;
  const w = (await listWorktrees(repo)).find((x) => x.path === want);
  if (!w) fail('InvalidInput', `${worktree} is not a worktree of this repository`);
  return w;
}

export async function worktreeRoot(repo: ReadRepo, worktree: string): Promise<string> {
  return (await worktreeOf(repo, worktree)).path;
}
