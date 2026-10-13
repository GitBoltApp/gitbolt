import type { HandlerTable } from '../transport';
import { blameFile } from '../engine/read/blame';
import { followLog } from '../engine/read/logWalk';
import { revParse } from '../engine/read/revs';
import { fail, isGbError, readRepoOf } from '../engine/read/seam';
import { checkRelative } from '../engine/read/worktree';
import { worktreeRoot } from '../engine/read/worktrees';

/** The most rows one page may ask for (the UI asks for 200). */
export const HISTORY_PAGE_MAX = 1000;

export const historyHandlers: Pick<HandlerTable, 'fileHistory' | 'blame'> = {
  fileHistory: async ({ repo: id, worktree, path, rev, skip, limit }, ctx) => {
    checkRelative(path);
    const r = rev ?? 'HEAD';
    if (r.startsWith('-')) fail('InvalidInput', `not a revision: ${r}`);
    const repo = readRepoOf(ctx, id);
    const root = await worktreeRoot(repo, worktree);
    const size = Math.min(Math.max(limit, 1), HISTORY_PAGE_MAX);
    // One row past the page says whether there's more (the core's `-n<skip+limit+1>`).
    const rows = await followLog(repo, await revParse(repo, r, root), path, skip + size + 1);
    return { rows: rows.slice(skip, skip + size), more: rows.length > skip + size };
  },
  blame: async ({ repo: id, worktree, rev, path }, ctx) => {
    checkRelative(path);
    if (rev.startsWith('-')) fail('InvalidInput', `not a revision: ${rev}`);
    const repo = readRepoOf(ctx, id);
    const root = await worktreeRoot(repo, worktree);
    const oid = await revParse(repo, rev, root);
    try {
      return await blameFile(repo, oid, path);
    } catch (e) {
      // git names the revision as the user spelled it (`HEAD`), not the commit it resolved to
      if (isGbError(e) && e.kind === 'Other' && e.message === `no such path ${path} in ${oid}`) fail('Other', `no such path ${path} in ${rev}`);
      throw e;
    }
  },
};
