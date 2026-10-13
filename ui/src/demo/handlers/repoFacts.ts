import type { SubmoduleInfo } from '../../api/gen/SubmoduleInfo';
import type { HandlerTable } from '../transport';
import { readIndex } from '../engine/read/indexFile';
import { filterConfigured, lfsTracked, topPatterns, usesLfs } from '../engine/read/lfs';
import { MODE_GITLINK } from '../engine/read/trees';
import { fail, readRepoOf } from '../engine/read/seam';
import { gitmodules, nestedHead } from '../engine/read/worktree';
import { worktreeOf, worktreeRoot } from '../engine/read/worktrees';

/** Canned: the demo answers as if this git-lfs were installed. */
export const LFS_VERSION = '3.6.1';

export const repoFactsHandlers: Pick<HandlerTable, 'submodules' | 'lfsStatus' | 'lfsTracked'> = {
  submodules: async ({ repo: id, worktree }, ctx) => {
    const repo = readRepoOf(ctx, id);
    const wt = await worktreeOf(repo, worktree);
    const mapped = new Set((await gitmodules(repo, wt.path)).map((m) => m.path));
    const out: SubmoduleInfo[] = [];
    const seen = new Set<string>();
    for (const e of await readIndex(repo, wt.gitdir)) {
      if (e.mode !== MODE_GITLINK || seen.has(e.path)) continue;
      seen.add(e.path);
      if (!mapped.has(e.path)) fail('Other', `fatal: no submodule mapping found in .gitmodules for path '${e.path}'`);
      if (e.stage !== 0) {
        out.push({ path: e.path, commit: '0'.repeat(40), status: 'conflicted' });
        continue;
      }
      const head = await nestedHead(repo, wt.path, e.path);
      out.push(head === null ? { path: e.path, commit: e.oid, status: 'uninitialized' } : { path: e.path, commit: head, status: head === e.oid ? 'current' : 'newCommits' });
    }
    return out;
  },
  lfsStatus: async ({ repo: id }, ctx) => {
    const repo = readRepoOf(ctx, id);
    return { used: await usesLfs(repo), version: LFS_VERSION, installUrl: 'https://git-lfs.com', patterns: await topPatterns(repo, repo.dir), filter: await filterConfigured(repo) };
  },
  lfsTracked: async ({ repo: id, worktree, paths }, ctx) => {
    const repo = readRepoOf(ctx, id);
    const root = await worktreeRoot(repo, worktree);
    return paths.length === 0 ? [] : lfsTracked(repo, root, paths);
  },
};
