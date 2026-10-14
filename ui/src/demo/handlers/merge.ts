// Merge and merge abort (write/integrate.rs): `git merge --no-edit <target>` as the demo does it
// (`runMerge`), a merge commit as the visitor or a stop on conflicts that pauses its journal entry
// (§13.2), and `git merge --abort`. A rebase goes to plan 4's `rebaseIntegrate`.
import type { IntegrateOutcome } from '../../api/gen/IntegrateOutcome';
import type { HandlerTable } from '../transport';
import { gitFailure } from '../engine/errors';
import { blobId, compareBytewise } from '../engine/read/bytes';
import { revParse } from '../engine/read/revs';
import { fail } from '../engine/read/seam';
import { listFiles, MODE_GITLINK, type FileEntry } from '../engine/read/trees';
import { checkoutEntry, kind, readFileState, removeWorktreePath } from '../engine/write/files';
import { loadIndex, saveIndex, stage0Of, unmergedOf, type IndexEntry } from '../engine/write/index';
import { rebaseIntegrate } from '../engine/seq/rebase';
import { runMerge } from '../engine/write/mergeRun';
import { clearMergeState } from '../engine/write/mergeState';
import { clearFolder, ignoredPath } from '../engine/write/move';
import { readHead, shortRef } from '../engine/write/refs';
import { runWrite, type WriteIntent } from '../engine/write/run';
import { writeTarget, type WriteWt } from '../engine/write/seam';
import { othersUnder } from '../engine/write/snapshot';
import { NO_EXPECT } from './stage';

function merge(target: string, seen: string, ffOnly: boolean, confirmAutostash: boolean): WriteIntent<IntegrateOutcome> {
  const short = shortRef(target);
  let label = `merge ${short} into ${seen}`;
  return {
    kind: 'merge',
    label: () => label,
    undo: () => 'rewind',
    confirm: { autostash: confirmAutostash },
    plan: async (pre) => {
      const branch = pre.before.head.branch;
      if (branch === null) fail('InvalidInput', 'Check out a branch to merge into it');
      label = `merge ${short} into ${branch}`;
      const theirs = await revParse(pre.wt.repo, target, pre.wt.root);
      return { autostash: { rule: { kind: 'merged' }, target: theirs, op: `merge ${target}`, targetName: target } };
    },
    run: (cx) => runMerge(cx, target, target, ffOnly),
  };
}

/** `git merge --abort` (`reset --merge` to HEAD): each path whose index differs from HEAD (conflicted
 *  ones included) goes back to HEAD's entry and file. It refuses first, so a refused abort changes
 *  nothing: unstaged changes on top of a merged entry, a file the index doesn't have where HEAD's goes
 *  back, a folder holding untracked files where HEAD has a file (ignored ones just go). */
async function resetMerge(wt: WriteWt): Promise<void> {
  const head = readHead(wt).oid;
  const tree = head === null ? new Map<string, FileEntry>() : await listFiles(wt.repo, head);
  const entries = await loadIndex(wt);
  const stage0 = stage0Of(entries);
  const unmerged = unmergedOf(entries);
  const paths = [...new Set([...entries.map((e) => e.path), ...tree.keys()])].sort(compareBytewise);
  const refuse = (message: string): never => {
    throw gitFailure(message, `error: ${message}\nfatal: Could not reset index file to revision 'HEAD'.\n`);
  };
  const indexed = new Set(entries.map((e) => e.path));
  const back: string[] = [];
  for (const p of paths) {
    const h = tree.get(p) ?? null;
    const i = stage0.get(p) ?? null;
    if (!unmerged.has(p) && (h === null ? i === null : i !== null && i.oid === h.oid && i.mode === h.mode)) continue;
    if (!unmerged.has(p) && i !== null) {
      const f = readFileState(wt, p);
      if (f !== null && (f.mode !== i.mode || (await blobId(f.bytes)) !== i.oid)) refuse(`Entry '${p}' not uptodate. Cannot merge.`);
    }
    if (h !== null && h.mode !== MODE_GITLINK && !unmerged.has(p) && i === null) {
      const k = kind(wt, `${wt.root}/${p}`);
      if (k === 'dir') {
        for (const f of othersUnder(wt, p, indexed)) if (!(await ignoredPath(wt, f))) refuse(`Updating '${p}' would lose untracked files in it`);
      } else if (k !== null && !(await ignoredPath(wt, p))) refuse(`Untracked working tree file '${p}' would be overwritten by merge.`);
    }
    back.push(p);
  }
  const going = new Set(back);
  const next: IndexEntry[] = entries.filter((e) => !going.has(e.path));
  // Removals first: a file HEAD has may take the place of a folder the merge made.
  for (const p of back) if (!tree.has(p)) removeWorktreePath(wt, p);
  for (const p of back) {
    const h = tree.get(p);
    if (!h) continue;
    // What's left of a folder there is ignored files.
    if (h.mode !== MODE_GITLINK && kind(wt, `${wt.root}/${p}`) === 'dir') clearFolder(wt, p);
    const stat = await checkoutEntry(wt, p, h);
    next.push({ path: p, mode: h.mode, oid: h.oid, stage: 0, ...(stat ? { stat } : {}) });
  }
  await saveIndex(wt, next);
}

function mergeAbort(): WriteIntent<IntegrateOutcome> {
  return {
    kind: 'merge',
    label: () => 'abort the merge',
    undo: () => null,
    allowedInProgress: true,
    run: async (cx) => {
      if (cx.before.inProgress !== 'merge') fail('InvalidInput', 'No merge is in progress');
      cx.command('merge', '--abort');
      await resetMerge(cx.wt);
      clearMergeState(cx.wt);
      for (const k of ['worktree', 'index', 'state'] as const) cx.touch(k);
      return { status: 'aborted' };
    },
  };
}

export const mergeHandlers: Pick<HandlerTable, 'integrate' | 'mergeAbort'> = {
  integrate: async ({ repo, worktree, kind, target, updateRefs, ffOnly, expect, confirm }, ctx) => {
    if (kind === 'rebase') return rebaseIntegrate(ctx, { repo, worktree, target, updateRefs: updateRefs ?? undefined, expect, confirm });
    // For the queue's label only: the branch settles in `plan`, under the lock.
    let seen = 'HEAD';
    try {
      seen = readHead(await writeTarget(ctx, repo, worktree)).branch ?? 'HEAD';
    } catch {
      // runWrite refuses an unknown worktree itself.
    }
    return runWrite(ctx, repo, worktree, expect, merge(target, seen, ffOnly === true, confirm.autostash));
  },
  mergeAbort: async ({ repo, worktree }, ctx) => runWrite(ctx, repo, worktree, NO_EXPECT, mergeAbort()),
};
