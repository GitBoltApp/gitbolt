// Cherry-pick and revert (the core's write/sequence.rs): committing, a sequence on the branch with
// stops Continue, Skip and Abort settle; without committing, each commit's change merged into the
// index and the files one at a time, nothing left in progress (a conflict waits in the Conflicted
// section). Neither makes a rewrite record: the core's `SequenceIntent` and `PickControl` have no
// `rewrite()`.
import type { Confirm } from '../../../api/gen/Confirm';
import type { SequenceOutcome } from '../../../api/gen/SequenceOutcome';
import { gbError } from '../errors';
import { compareBytewise } from '../read/bytes';
import { readCommitOrNull } from '../read/commitText';
import { relation } from '../read/revs';
import { fail, type ReadRepo } from '../read/seam';
import { diffTrees } from '../read/trees';
import { worktreeOf } from '../read/worktrees';
import {
  applyMerge, dirtyPaths, markPartial, markStoppedPick, readIndexEntries, refuseIndexForPick, refuseMergeOver, snapshotAfter, snapshotPaths, widenSnapshot, writeTreeFromIndex,
  type MergeResult, type WriteCx, type WriteIntent,
} from '../writeSeam';
import { startSeq } from './engine';
import { shortOid } from './range';
import { replay, treeOf } from './replay';

export type SeqWhich = 'cherryPick' | 'revert';

/** The command, as git names it. */
const gitName = (k: SeqWhich): 'cherry-pick' | 'revert' => (k === 'cherryPick' ? 'cherry-pick' : 'revert');

/** `a1b2c3d` for one commit, `3 commits` for more (how labels and the pause name them). */
export function what(oids: string[]): string {
  return oids.length === 1 ? shortOid(oids[0]) : `${oids.length} commits`;
}

/** A commit this can apply: it exists, and isn't a merge ("pick a parent" is out of scope). */
async function pickable(read: ReadRepo, hex: string): Promise<void> {
  const short = shortOid(hex);
  if (!/^[0-9a-f]{40}$/.test(hex)) fail('InvalidInput', `not an object id: ${hex}`);
  const c = (await readCommitOrNull(read, hex)) ?? fail('NotFound', `${short} isn't a commit in this repository`);
  if (c.parents.length > 1) fail('InvalidInput', `${short} is a merge commit: GitVolt doesn't cherry-pick or revert merges`);
}

/** The paths `hex` changes against its first parent (a root commit: its whole tree). */
async function pathsOf(read: ReadRepo, hex: string): Promise<string[]> {
  const c = (await readCommitOrNull(read, hex))!;
  const parent = c.parents.length ? await treeOf(read, c.parents[0]) : null;
  return (await diffTrees(read, parent, c.tree)).map((ch) => ch.path);
}

/** Every path the run changed outside what it began with (dirty now, and not before it): P follows
 *  the commits' own paths, but git follows renames on HEAD's side, so these join the `before`
 *  snapshot too (the state they were in: HEAD's). The core's `widen`. */
async function widen(cx: WriteCx, beforeDirty: Set<string>): Promise<string[]> {
  const now = await dirtyPaths(cx);
  const changed = [...new Set([...now.tracked, ...now.untracked, ...now.unmerged])].filter((p) => !beforeDirty.has(p)).sort(compareBytewise);
  const have = new Set(snapshotPaths(cx) ?? []);
  await widenSnapshot(cx, changed.filter((p) => !have.has(p)));
  return changed;
}

/** "Without committing": each commit in git's order merged into the index and the files, so a stop
 *  knows which commit stopped it and how many went in; nothing is left in progress. A conflict stops
 *  it with the conflicted files in the index; there's nothing to Continue. */
async function runNoCommit(cx: WriteCx, kind: SeqWhich, order: string[]): Promise<SequenceOutcome> {
  const op = gitName(kind);
  const how = { op, noCommit: true } as const;
  // What's dirty outside P now, before any pick, is the user's.
  const before = await dirtyPaths(cx);
  const beforeDirty = new Set([...before.tracked, ...before.untracked]);
  const attempted = new Set<string>();
  let applied = 0;
  for (const oid of order) {
    const paths = await pathsOf(cx.read, oid);
    for (const k of ['worktree', 'index', 'state'] as const) cx.touch(k);
    let merged: MergeResult;
    try {
      await refuseIndexForPick(cx, how);
      merged = await replay(cx.read, oid, await writeTreeFromIndex(cx.read, cx.gitdir), kind === 'revert' ? 'revert' : 'pick');
      await refuseMergeOver(cx, merged, how);
      await applyMerge(cx, '', merged);
    } catch (e) {
      // A failure without conflicts (a file in the way) changed nothing of its own. Before anything
      // else changed, there's no entry; after an earlier commit went in, the entry is a stopped one
      // over what the run changed: its Undo discards exactly that.
      const changed = await widen(cx, beforeDirty);
      if (applied > 0 || changed.length > 0) {
        markPartial(cx);
        for (const p of changed) attempted.add(p);
        markStoppedPick(cx, op, attempted);
      }
      throw e;
    }
    if (merged.tree === null) {
      // A conflict changed the index and the files: the entry stays, marked first.
      markPartial(cx);
      for (const p of paths) attempted.add(p);
      markStoppedPick(cx, op, attempted);
      for (const p of await widen(cx, beforeDirty)) attempted.add(p);
      markStoppedPick(cx, op, attempted);
      const files = new Set((await readIndexEntries(cx.read, cx.gitdir)).filter((e) => e.stage !== 0).map((e) => e.path)).size;
      return { status: 'stopped', files, at: oid, applied, committed: false };
    }
    // From the first commit in, the index and the files changed: a later failure keeps the entry.
    markPartial(cx);
    for (const p of paths) attempted.add(p);
    applied++;
  }
  await widen(cx, beforeDirty);
  await snapshotAfter(cx);
  return { status: 'done', commits: applied, committed: false };
}

/** `seen`: HEAD's branch as the request saw it, for the queue's label (it settles in `plan`). */
export function sequenceIntent(o: { kind: SeqWhich; oids: string[] /* newest first */; noCommit: boolean; confirm: Confirm; seen?: string }): WriteIntent<SequenceOutcome> {
  const order = o.kind === 'cherryPick' ? [...o.oids].reverse() : [...o.oids];
  const suffix = o.noCommit ? ' without committing' : '';
  let branch = o.seen ?? 'HEAD';
  const intent: WriteIntent<SequenceOutcome> = {
    kind: 'commit',
    label: () => (o.kind === 'cherryPick' ? `cherry-pick ${what(o.oids)} onto ${branch}${suffix}` : `revert ${what(o.oids)}${suffix}`),
    undo: o.noCommit ? 'restore' : 'rewind',
    confirm: o.confirm,
    async plan(pre) {
      branch = pre.before.head.branch ?? fail('InvalidInput', o.kind === 'cherryPick' ? 'Check out a branch to cherry-pick onto it' : 'Check out a branch to make the revert on');
      // An unborn branch has no commit to pick onto.
      if (pre.before.head.oid === null) fail('InvalidInput', 'Make a first commit first');
      if (o.oids.length === 0) fail('InvalidInput', o.kind === 'cherryPick' ? 'Nothing to cherry-pick' : 'Nothing to revert');
      for (const h of o.oids) await pickable(pre.read, h);
      // P: every path the commits change.
      const paths = [...new Set((await Promise.all(o.oids.map((h) => pathsOf(pre.read, h)))).flat())].sort(compareBytewise);
      if (o.noCommit) {
        // The snapshot over P is the Undo; the user's own changes there would be mixed in, so they refuse.
        const dirty = await dirtyPaths(pre);
        const inP = new Set(paths);
        const p = [...[...dirty.tracked].sort(compareBytewise), ...[...dirty.untracked].sort(compareBytewise)].find((x) => inP.has(x));
        if (p !== undefined) throw gbError('DirtyWorktree', `Commit or stash your changes to ${p} first: the ${gitName(o.kind)} changes it too`);
        return { snapshot: { paths } };
      }
      // P is what the picks touch, so an untracked file there is stashed too.
      return { autostash: { rule: { kind: 'touching', paths }, target: null, op: intent.label(), targetName: what(o.oids) } };
    },
    async run(cx) {
      if (o.noCommit) return runNoCommit(cx, o.kind, order);
      const old = cx.before.head.oid!;
      // git refuses an unmerged or staged index before it picks anything. Practically unreachable
      // here: the autostash fails first on an unmerged index ("could not write index", as git's
      // stash push does) and takes any staged change; kept as the command's own words.
      await refuseIndexForPick(cx, { op: gitName(o.kind), noCommit: false });
      const full = `refs/heads/${branch}`;
      const end = await startSeq(cx, {
        kind: o.kind, headName: full, origHead: old, onto: old, target: what(o.oids), interactive: false,
        steps: order.map((oid) => ({ op: 'pick', oid, parent: null })), range: order, refsBefore: {}, deletes: {}, empty: 'stop',
      });
      const head = end.status === 'done' ? end.head : (await worktreeOf(cx.read, cx.root)).head!;
      const [applied] = await relation(cx.read, head, old);
      if (end.status === 'done') return { status: 'done', commits: applied, committed: true };
      cx.paused = { kind: o.kind, target: what(o.oids), targetOid: null, picked: order, irebase: false };
      return { status: 'stopped', files: end.files, at: end.stop.at, applied, committed: true, ...(end.stop.reason === 'empty' ? { error: end.stop.error! } : {}) };
    },
  };
  return intent;
}
