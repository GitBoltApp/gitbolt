// Commit, Stage all & commit, Amend and the HEAD message's edit (write/commit.rs, spec #2 §8): what
// `git commit -q -F -` (`--amend`, `--amend --only --allow-empty`) does, as the visitor at the demo's
// clock, with git's `whitespace` cleanup of the message. Journaled as MoveRefs, or MoveHead on a
// detached HEAD (Deviation 9). No hooks or signing in the demo.
import type { CommitOutcome } from '../../api/gen/CommitOutcome';
import type { HandlerTable } from '../transport';
import { readCommit } from '../engine/read/commitText';
import { ancestors } from '../engine/read/revs';
import { fail, readRepoOf } from '../engine/read/seam';
import { worktreeOf } from '../engine/read/worktrees';
import { trackingRef } from '../engine/remotes';
import type { DemoRepo } from '../engine/repo';
import { loadIndex, saveIndex } from '../engine/write/index';
import { readInProgress } from '../engine/write/inProgress';
import { clearMergeState, readMergeHead } from '../engine/write/mergeState';
import { cleanupWhitespace, DEMO_IDENTITY, rawAuthor, writeCommitObject, writeIndexTree } from '../engine/write/objects';
import { readRef, setHead, shortRef } from '../engine/write/refs';
import { runWrite, type WriteCx, type WriteIntent } from '../engine/write/run';
import { statusEntries } from '../engine/write/status';
import { addAll } from './stage';

/** §8.1: the summary, plus a blank line and the description when there is one. */
export const commitMessageOf = (summary: string, description: string): string => (description.trim() === '' ? summary : `${summary}\n\n${description}`);

const firstLine = (message: string) => (message.split('\n')[0] ?? '').replace(/\r$/, '');

/** HEAD's branch moved by CAS from `from` to `to` (created when unborn), or a detached HEAD itself. */
export function advanceHead(cx: WriteCx, from: string | null, to: string): void {
  const branch = cx.before.head.branch;
  if (branch !== null) cx.cas([{ name: `refs/heads/${branch}`, old: from, new: to }]);
  else setHead(cx.wt, { oid: to });
}

/** UX L: Amend at the "about to commit" Edit stop before any piece is committed (the core's). */
export const AMEND_AT_EDIT_STOP = "Nothing to amend yet: this commit's changes are staged. Commit them, or Continue.";
/** An Edit stop of a rebase GitVolt's interactive rebase doesn't own (the core's `NOT_OURS`). */
const NOT_OURS = 'Finish this rebase where you started it.';

function commit(summary: string, description: string, amend: boolean, stageAll: boolean): WriteIntent<CommitOutcome> {
  let detached = false;
  // At an Edit stop of the interactive rebase: the commit is the paused rebase's own, no entry of its own.
  let paused = false;
  return {
    kind: 'commit',
    label: () => `${amend ? 'amend' : 'commit'} "${summary}"`,
    undo: () => (paused ? null : detached ? 'moveHead' : 'moveRefs'),
    rewrite: () => (amend ? 'amend' : null),
    // In a merge, Commit makes the merge commit (§13.2); at an interactive rebase's Edit stop it
    // commits there (3C T5); `plan` refuses any other operation.
    allowedInProgress: true,
    plan: async (pre) => {
      const ip = pre.before.inProgress;
      // 3C T5: an Edit stop (no conflict left) takes commits, its pieces (UX L).
      const st = ip === 'rebase' ? readInProgress(pre.wt.fs, pre.wt.gitdir) : null;
      const editStop = st?.kind === 'rebase' && st.editStop !== null && st.conflicted === 0;
      const editBase = editStop && st?.kind === 'rebase' ? st.editBase : null;
      // At the "about to commit" stop, HEAD is the commit's parent: an amend would fold the commit into it.
      if (amend && editBase !== null && pre.before.head.oid === editBase) fail('InvalidInput', AMEND_AT_EDIT_STOP);
      // Only GitVolt's own interactive rebase, whose pause records the commits made there.
      if (editStop && !pre.ctx.writes.journal(pre.wt.root).paused()?.paused?.irebase) fail('InvalidInput', NOT_OURS);
      if (ip !== null && ip !== 'merge' && !editStop) fail('InProgress', `A ${ip} is in progress`);
      paused = editStop;
      if (summary.trim() === '') fail('InvalidInput', 'Write a commit summary');
      if (amend && (stageAll || pre.before.head.oid === null)) fail('InvalidInput', stageAll ? "Amend doesn't stage everything" : 'Nothing to amend');
      const merging = ip === 'merge';
      if (merging && amend) fail('InProgress', 'A merge is in progress');
      const entries = await statusEntries(pre.wt.repo, pre.wt.root);
      const conflicted = entries.filter((e) => e.kind === 'unmerged').length;
      if (conflicted > 0) fail('InvalidInput', `Resolve ${conflicted} conflicted ${conflicted === 1 ? 'file' : 'files'} first`);
      // A merge commits even with nothing staged (its result may equal HEAD's tree).
      if (!amend && !merging) {
        const staged = entries.some((e) => (e.kind === 'ordinary' || e.kind === 'renamed') && e.index !== '.');
        if (!staged && !(stageAll && entries.length > 0)) fail('InvalidInput', 'Nothing to commit');
      }
      detached = pre.before.head.branch === null && pre.before.head.oid !== null;
      return {};
    },
    run: async (cx) => {
      const wt = cx.wt;
      let entries = await loadIndex(wt);
      if (stageAll) {
        const before = await writeIndexTree(wt.repo, entries);
        cx.editEntry((e) => {
          e.indexBefore = before;
        });
        entries = await addAll(wt, entries);
        await saveIndex(wt, entries);
        cx.command('add', '-A');
      }
      const head = cx.before.head.oid;
      const mergeHeads = cx.before.inProgress === 'merge' ? readMergeHead(wt) : [];
      const tree = await writeIndexTree(wt.repo, entries);
      const parents = amend ? (await readCommit(wt.repo, head!)).parents : [...(head ? [head] : []), ...mergeHeads];
      const author = amend ? await rawAuthor(wt.repo, head!) : cx.ident();
      const oid = await writeCommitObject(wt.repo, { tree, parents, author, committer: cx.ident(), message: cleanupWhitespace(commitMessageOf(summary, description)) });
      advanceHead(cx, head, oid);
      // The merge state goes with the commit; the core's commit touches no State for it (commit.rs).
      if (mergeHeads.length > 0) clearMergeState(wt);
      cx.touch('index');
      cx.command('commit', '-q', '-F', '-', ...(amend ? ['--amend'] : []));
      // 3C T5: a commit at an Edit stop is the paused rebase's own (settle counts it, an Abort keeps it).
      const session = paused ? cx.journal.paused()?.paused?.irebase : null;
      if (session) {
        session.made.push(oid);
        cx.journalChanged = true;
      }
      return { oid };
    },
  };
}

function editHeadMessage(message: string): WriteIntent<CommitOutcome> {
  let detached = false;
  return {
    kind: 'commit',
    label: () => `amend "${firstLine(message)}"`,
    undo: () => (detached ? 'moveHead' : 'moveRefs'),
    rewrite: () => 'amend',
    plan: async (pre) => {
      if (firstLine(message).trim() === '') fail('InvalidInput', 'Write a commit summary');
      if (pre.before.head.oid === null) fail('InvalidInput', 'Nothing to amend');
      detached = pre.before.head.branch === null;
      return {};
    },
    run: async (cx) => {
      const head = cx.before.head.oid!;
      const c = await readCommit(cx.wt.repo, head);
      const oid = await writeCommitObject(cx.wt.repo, { tree: c.tree, parents: c.parents, author: await rawAuthor(cx.wt.repo, head), committer: cx.ident(), message: cleanupWhitespace(message) });
      advanceHead(cx, head, oid);
      cx.command('commit', '-q', '--amend', '--only', '--allow-empty', '-F', '-');
      return { oid };
    },
  };
}

/** `shelldata::upstream_ref`: `branch.<b>.merge` through the remote's fetch refspecs, or the local branch for remote `.`. */
export async function upstreamOf(demo: DemoRepo, branch: string): Promise<string | null> {
  const remote = await demo.config(`branch.${branch}.remote`);
  const merge = (await demo.configAll(`branch.${branch}.merge`))[0];
  if (remote === null || merge === undefined) return null;
  const mapped = trackingRef(await demo.configAll(`remote.${remote}.fetch`), merge);
  if (mapped !== null) return mapped;
  return remote === '.' ? (merge.startsWith('refs/') ? merge : `refs/heads/${merge}`) : null;
}

export const commitHandlers: Pick<HandlerTable, 'commit' | 'editHeadMessage' | 'headOnUpstream' | 'commitIdentity'> = {
  commit: async ({ repo, worktree, summary, description, amend, stageAll, expect }, ctx) => runWrite(ctx, repo, worktree, expect, commit(summary, description, amend, stageAll)),
  editHeadMessage: async ({ repo, worktree, message, expect }, ctx) => runWrite(ctx, repo, worktree, expect, editHeadMessage(message)),
  headOnUpstream: async ({ repo, worktree }, ctx) => {
    const r = readRepoOf(ctx, repo);
    const w = await worktreeOf(r, worktree);
    if (!w.branch?.startsWith('refs/heads/') || w.head === null) return null;
    const demo = ctx.repos.get(repo);
    const upstream = await upstreamOf(demo, w.branch.slice('refs/heads/'.length));
    const up = upstream === null ? null : readRef(demo, upstream);
    if (upstream === null || up === null) return null;
    return w.head === up || (await ancestors(r, up)).has(w.head) ? shortRef(upstream) : null;
  },
  // The visitor commits, whatever the repository's config says (the interfaces doc).
  commitIdentity: async ({ repo, worktree }, ctx) => {
    await worktreeOf(readRepoOf(ctx, repo), worktree);
    return { name: DEMO_IDENTITY.name, email: DEMO_IDENTITY.email };
  },
};
