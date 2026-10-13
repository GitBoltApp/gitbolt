import type { HandlerTable } from '../transport';
import { compareBytewise } from '../engine/read/bytes';
import { treeChanges, totals, wipStaged, wipUnstaged, worktreeChanges } from '../engine/read/changes';
import { parseOid, readCommit } from '../engine/read/commitText';
import { readIndex } from '../engine/read/indexFile';
import { listFiles, MODE_GITLINK } from '../engine/read/trees';
import { fail, readRepoOf } from '../engine/read/seam';
import { pathKind } from '../engine/read/worktree';
import { worktreeOf, worktreeRoot } from '../engine/read/worktrees';

export const filesHandlers: Pick<HandlerTable, 'fileList' | 'treeFiles' | 'worktreeFiles' | 'worktreePathKind'> = {
  fileList: async ({ repo: id, spec }, ctx) => {
    const repo = readRepoOf(ctx, id);
    switch (spec.kind) {
      case 'commit': {
        const oid = parseOid(spec.id);
        const { parents } = await readCommit(repo, oid);
        if (spec.parent < parents.length) return totals(await treeChanges(repo, parents[spec.parent], oid));
        if (parents.length === 0) return totals(await treeChanges(repo, null, oid));
        return fail('InvalidInput', `commit ${oid} has ${parents.length} parent(s); there is no parent ${spec.parent + 1}`);
      }
      case 'compare':
        return totals(await treeChanges(repo, parseOid(spec.from), parseOid(spec.to)));
      case 'worktree': {
        const root = await worktreeRoot(repo, spec.worktree);
        return totals(await worktreeChanges(repo, root, parseOid(spec.from)));
      }
      case 'wip': {
        const root = await worktreeRoot(repo, spec.worktree);
        return totals(spec.staged ? await wipStaged(repo, root) : await wipUnstaged(repo, root));
      }
    }
  },
  treeFiles: async ({ repo: id, id: commit }, ctx) => {
    const repo = readRepoOf(ctx, id);
    const oid = parseOid(commit);
    await readCommit(repo, oid);
    return [...(await listFiles(repo, oid)).keys()].sort(compareBytewise);
  },
  worktreeFiles: async ({ repo: id, worktree }, ctx) => {
    const repo = readRepoOf(ctx, id);
    const wt = await worktreeOf(repo, worktree);
    const paths = (await readIndex(repo, wt.gitdir)).filter((e) => e.mode !== MODE_GITLINK).map((e) => e.path);
    return [...new Set(paths)].sort(compareBytewise);
  },
  worktreePathKind: async ({ repo: id, worktree, path }, ctx) => {
    const repo = readRepoOf(ctx, id);
    return pathKind(repo, await worktreeRoot(repo, worktree), path);
  },
};
