import type { HandlerTable } from '../transport';
import { selectedLines } from '../engine/read/patchSelect';
import { fail, readRepoOf } from '../engine/read/seam';
import { baseOf, BINARY, hunkSummary, wipDiff } from '../engine/read/wipDiff';
import { worktreeRoot } from '../engine/read/worktrees';

export const hunksHandlers: Pick<HandlerTable, 'wipHunks' | 'selectionLines'> = {
  wipHunks: async ({ repo: id, worktree, path, staged }, ctx) => {
    const repo = readRepoOf(ctx, id);
    const root = await worktreeRoot(repo, worktree);
    const base = await baseOf(repo, root, path);
    const d = await wipDiff(repo, root, path, staged);
    if (typeof d === 'string') return { base, hunks: [], binary: d === BINARY, refused: d };
    return { base, hunks: d.hunks.map(hunkSummary), binary: false, refused: null };
  },
  selectionLines: async ({ repo: id, worktree, path, staged, selection }, ctx) => {
    const repo = readRepoOf(ctx, id);
    const d = await wipDiff(repo, await worktreeRoot(repo, worktree), path, staged);
    if (typeof d === 'string') fail('InvalidInput', d);
    return { apply: selectedLines(d.hunks, selection, staged ? 'reverse' : 'forward').lines, discard: selectedLines(d.hunks, selection, 'reverse').lines };
  },
};
