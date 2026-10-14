// `git merge --no-edit <target>` (`--ff-only`) as the demo does it (write/integrate.rs's `run_merge`),
// written from git's behaviour and checked against the git binary: up to date, a fast-forward (the
// two-way move), or Task 14's tree merge written into the worktree and the index, then a merge commit
// as the visitor or a stop on conflicts with the merge files. Not here (nothing in the demo has
// them): hooks, `merge.ff`, signing, rerere; a criss-cross history merges from one base, where git
// merges the bases first. Merge, and plan 4's pull, run it.
import type { ChangeKind } from '../../../api/gen/ChangeKind';
import type { IntegrateOutcome } from '../../../api/gen/IntegrateOutcome';
import type { GbError } from '../../../api/gen/GbError';
import { gitFailure } from '../errors';
import { AttrReader, markerSizeOf } from '../read/attributes';
import { ancestors, mergeBaseOf, relation, revParse } from '../read/revs';
import { fail } from '../read/seam';
import { MODE_GITLINK } from '../read/trees';
import { kind } from './files';
import { loadIndex, unmergedOf } from './index';
import { mergeMessage, writeMergeState, writeOrigHead } from './mergeState';
import { applyMerge, mergeTrees, resultTree, type TreeMerge } from './mergeTrees';
import { foldersOf, refusal, twoWayMove, unmergedRefusal, type Why } from './move';
import { writeCommitObject, writeIndexTree } from './objects';
import type { WriteCx } from './run';
import type { WriteWt } from './seam';
import { statusEntries, type StatusEntry } from './status';

const ORT_FAILED = 'Merge with strategy ort failed.\n';

async function refuseUnmerged(wt: WriteWt): Promise<void> {
  const unmerged = [...unmergedOf(await loadIndex(wt)).keys()];
  if (unmerged.length > 0) throw unmergedRefusal('merge', unmerged);
}

/** The paths where writing `m` would lose something (git's refusal of a merge, a stash apply's
 *  too): an unstaged change in a path it writes, a folder holding untracked files where it writes a
 *  file, and an untracked file where it writes one or needs a folder (ignored files just go). */
export function worktreeProblems(wt: WriteWt, m: TreeMerge, entries: StatusEntry[]): Map<string, Why> {
  const touched = new Set(m.touched);
  const untracked = new Set(entries.filter((e) => e.kind === 'untracked').map((e) => e.path));
  const problems = new Map<string, Why>();
  for (const e of entries) if (e.kind !== 'untracked' && e.worktree !== '.' && touched.has(e.path)) problems.set(e.path, 'dirty');
  for (const [p, w] of m.worktree) {
    if (w === null) continue;
    if (untracked.has(p)) problems.set(p, 'untracked');
    else if (w.mode !== MODE_GITLINK && kind(wt, `${wt.root}/${p}`) === 'dir' && [...untracked].some((u) => u.startsWith(`${p}/`))) problems.set(p, 'lost');
    for (const up of foldersOf(p)) if (untracked.has(up)) problems.set(up, 'untracked');
  }
  return problems;
}

/** Which command a refusal speaks for: a cherry-pick or revert (`noCommit`: without committing),
 *  whose words differ from a merge's where git's do (checked against the binary, 2.53). */
export interface PickRefusal {
  op: 'cherry-pick' | 'revert';
  noCommit: boolean;
}

/** `git cherry-pick`/`revert` over an unmerged index: committing says so in its own words, without
 *  committing it reads the index first. */
function unmergedForPick(how: PickRefusal, paths: string[]): GbError {
  if (how.noCommit) {
    const stderr = `${paths.map((p) => `${p}: unmerged\n`).join('')}error: your index file is unmerged.\nfatal: ${how.op} failed\n`;
    return gitFailure('your index file is unmerged.', stderr);
  }
  const message = `${how.op === 'revert' ? 'Reverting' : 'Cherry-picking'} is not possible because you have unmerged files.`;
  const hints = "hint: Fix them up in the work tree, and then use 'git add/rm <file>'\nhint: as appropriate to mark resolution and make a commit.\n";
  return gitFailure(message, `error: ${message}\n${hints}fatal: ${how.op} failed\n`);
}

const stagedForPick = (op: PickRefusal['op']): GbError => {
  const message = `your local changes would be overwritten by ${op}.`;
  return gitFailure(message, `error: ${message}\nhint: commit your changes or stash them to proceed.\nfatal: ${op} failed\n`);
};

/** What `git merge` refuses before it writes anything (an autostash, Task 20, usually spares this):
 *  an unmerged index; any staged change (git checks the index first, alone); then, together, the
 *  worktree's problems. A cherry-pick or revert (`how`) says "cherry-pick"/"revert" for the staged
 *  change, and doesn't refuse one at all without committing (its own earlier picks are staged), but
 *  words the worktree's problems as a merge's. */
export async function refuseLocalChanges(wt: WriteWt, m: TreeMerge, how?: PickRefusal): Promise<void> {
  const unmerged = [...unmergedOf(await loadIndex(wt)).keys()];
  if (unmerged.length > 0) throw how ? unmergedForPick(how, unmerged) : unmergedRefusal('merge', unmerged);
  const entries = await statusEntries(wt.repo, wt.root);
  const staged = entries.filter((e) => e.kind !== 'untracked' && e.index !== '.').map((e) => e.path);
  if (staged.length > 0 && !how?.noCommit) {
    if (how) throw stagedForPick(how.op);
    const message = 'Your local changes to the following files would be overwritten by merge:';
    throw gitFailure(message, `error: ${message}\n  ${staged.join(' ')}\n${ORT_FAILED}`);
  }
  const problems = worktreeProblems(wt, m, entries);
  if (problems.size > 0) {
    const e = refusal('merge', problems, (p) => p);
    throw gitFailure(e.message, `${e.stderr ?? ''}${how ? `fatal: ${how.op} failed\n` : ORT_FAILED}`);
  }
}

/** The index of a cherry-pick or revert about to start: git refuses before it picks anything when
 *  it's unmerged, or (committing) holds a staged change (the autostash took P's already). */
export async function refuseIndexFor(wt: WriteWt, how: PickRefusal): Promise<void> {
  const unmerged = [...unmergedOf(await loadIndex(wt)).keys()];
  if (unmerged.length > 0) throw unmergedForPick(how, unmerged);
  if (!how.noCommit && (await statusEntries(wt.repo, wt.root)).some((e) => e.kind !== 'untracked' && e.index !== '.')) throw stagedForPick(how.op);
}

/** What the core's `run_merge` marks changed; a pull's fast-forward runs its own `git merge
 *  --ff-only`, which leaves `state` out (sync.rs). */
export const MERGE_KINDS: readonly ChangeKind[] = ['worktree', 'index', 'refs', 'state'];

/** The merge of `target` into HEAD's branch (the core's `run_merge`). A stop on conflicts pauses
 *  with `label` as the banner's target and MERGE_HEAD as its oid. */
export async function runMerge(cx: WriteCx, target: string, label: string, ffOnly: boolean, kinds: readonly ChangeKind[] = MERGE_KINDS): Promise<IntegrateOutcome> {
  const wt = cx.wt;
  const theirs = await revParse(wt.repo, target, wt.root);
  const branch = cx.before.head.branch!;
  const name = `refs/heads/${branch}`;
  const head = cx.before.head.oid;
  for (const k of kinds) cx.touch(k);
  cx.command('merge', ffOnly ? '--ff-only' : '--no-edit', target);
  // The core reads HEAD's commit before it runs git: an unborn branch fails there.
  if (head === null) fail('Other', `Branch '${name}' does not have any commits`);
  await refuseUnmerged(wt);
  // git writes ORIG_HEAD once the index is merged, whatever follows (up to date, a refusal).
  writeOrigHead(wt, head);
  if ((await ancestors(wt.repo, head)).has(theirs)) return { status: 'upToDate' };
  if ((await ancestors(wt.repo, theirs)).has(head)) {
    await twoWayMove(wt, head, theirs, 'merge');
    cx.cas([{ name, old: head, new: theirs }]);
    const [commits] = await relation(wt.repo, theirs, head);
    return { status: 'done', commits, fastForward: true };
  }
  if (ffOnly) {
    const message = 'Not possible to fast-forward, aborting.';
    const hint = ["Diverging branches can't be fast-forwarded, you need to either:", '', '\tgit merge --no-ff', '', 'or:', '', '\tgit rebase', '', 'Disable this message with "git config set advice.diverging false"'];
    throw gitFailure(message, `${hint.map((l) => (l === '' ? 'hint:\n' : `hint: ${l}\n`)).join('')}fatal: ${message}\n`);
  }
  const base = await mergeBaseOf(wt.repo, head, theirs);
  if (base === null) throw gitFailure('refusing to merge unrelated histories', 'fatal: refusing to merge unrelated histories\n');
  const attrs = new AttrReader(wt.repo, wt.root);
  const m = await mergeTrees(wt.repo, base, head, theirs, { ours: 'HEAD', theirs: target }, (p) => markerSizeOf(attrs, p));
  await refuseLocalChanges(wt, m);
  await applyMerge(wt, m);
  const message = await mergeMessage(wt, target, branch);
  if (m.conflicts.length > 0) {
    writeMergeState(wt, { mergeHead: theirs, message, conflicts: m.conflicts, autoMerge: await resultTree(wt.repo, m) });
    cx.paused = { kind: 'merge', target: label, targetOid: theirs, picked: [], irebase: null };
    // As the core counts them (`in_progress::read`): the index's conflicted paths.
    return { status: 'stopped', kind: 'merge', files: unmergedOf(await loadIndex(wt)).size };
  }
  const tree = await writeIndexTree(wt.repo, await loadIndex(wt));
  const ident = cx.ident();
  const oid = await writeCommitObject(wt.repo, { tree, parents: [head, theirs], author: ident, committer: ident, message });
  cx.cas([{ name, old: head, new: oid }]);
  const [commits] = await relation(wt.repo, oid, head);
  return { status: 'done', commits, fastForward: false };
}
