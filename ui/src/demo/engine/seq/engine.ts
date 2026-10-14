// The sequencer's runner (plan 4): a rebase, cherry-pick or revert as steps applied one at a time,
// with stops the commit panel's Continue, Skip and Abort settle. Built on phase 3's tree merge and
// checkout; git's own sequencer isn't used or translated (the clean-room rule): its observable
// behaviour is, as the plan's Decisions describe it and as the git binary showed it (2.53, the
// Task 4 ledger: messages, empty picks, a Continue's cleanup). The core's own Rust is ported where
// it adds to git: the Edit stop's Continue (irebase/edit.rs `commit_at_stop`), the chips' moves
// and deletes on the paused entry (irebase/run.rs `completed_step`, `delete_chips`).
import { compareBytewise } from '../read/bytes';
import { firstLine, gitSubject, readCommit } from '../read/commitText';
import { ancestors, mergeBaseOf } from '../read/revs';
import { demoOf, fail, lstatOrNull, type ReadRepo } from '../read/seam';
import { diffTrees, listFiles } from '../read/trees';
import { listWorktrees, worktreeOf } from '../read/worktrees';
import { asGbError, gbError, gitFailure } from '../errors';
import { trimEndRust } from '../objects';
import {
  applyMerge, checkoutTree, cleanupStrip, cleanupWhitespace, conflicted as conflictedIn, gitMovesRefs, mergeTrees, notePaused, rawAuthor, readIndexEntries, readRef, recordOnPaused,
  pausedSession, reflogMessage, refsTick, refuseMergeOver, removeBranchConfig, setHead, shortRef, statusEntries, writeCommitObject, writeOrigHead, writeTreeFromIndex,
  type MergeResult, type PickRefusal, type RefMove, type Signature, type WriteCx,
} from '../writeSeam';
import { clearLeftovers, finishKeptWork, keepWork, noteStop } from './keepWork';
import { shortOid as short } from './range';
import { replay, treeOf } from './replay';
import { clearSeq, inProgressWord, mergedMessage, readSeq, writeSeq, type Amend, type SeqKind, type SeqState, type Step, type Stop } from './state';

export interface SeqStart {
  kind: SeqKind;
  headName: string | null;
  origHead: string;
  onto: string;
  target: string;
  interactive: boolean;
  /** Every todo line, `line` steps included: `total` counts them all, as git's `end`. */
  steps: Step[];
  range: string[];
  refsBefore: Record<string, string | null>;
  deletes: Record<string, string>;
  empty: 'drop' | 'stop';
  /** Where a step's parent outside the range goes (default `onto`): a rebase with merges keeps a
   *  line that didn't start on a merge base where it was. */
  map?: Record<string, string>;
}
/** `warning`: a chip marked delete that was kept (it changed meanwhile), as the core's R1. */
export type SeqEnd = { status: 'done'; head: string; moves: RefMove[]; warning?: string } | { status: 'stopped'; stop: Stop; files: number };
export interface Aborted { stash: string | null; branch: string | null }

/** What an empty pick stops with: git's own words (the binary's, for a cherry-pick and a rebase). */
export const EMPTY_PICK = 'The previous cherry-pick is now empty, possibly due to conflict resolution.';
/** What the core reports when git fails with nothing on stderr (an empty revert: git prints its
 *  status on stdout and exits 1). */
const GIT_EXITED = 'git exited with status 1';
/** The core's `COMMIT_OR_DISCARD` (irebase/edit.rs): Continue at an Edit stop with unstaged changes. */
export const COMMIT_OR_DISCARD = 'Commit or discard your changes first';
/** The core's `not_staged` (irebase/edit.rs). */
export const notStaged = (file: string): string => `${file} from this commit isn't staged. Stage it, or discard it, then Continue.`;

/** A commit's author line as stored, its time zone included (F3: phase 3's `rawAuthor`). */
export async function authorOf(read: ReadRepo, oid: string): Promise<string> {
  return rawAuthor(read, oid);
}

/** git's revert message for a commit whose subject (its first non-blank line, as stored) is
 *  `subject`; a revert of a revert says `Reapply`, but a revert of that again says `Revert` (checked
 *  against the binary, 2.53). */
export function revertMessage(oid: string, subject: string): string {
  const REVERT = 'Revert "';
  const rest = subject.startsWith(REVERT) ? subject.slice(REVERT.length) : null;
  const title = rest !== null && !rest.startsWith(REVERT) ? `Reapply "${rest}` : `Revert "${subject}"`;
  return `${title}\n\nThis reverts commit ${oid}.\n`;
}

/** A picked commit's message as git writes it: the original's, its leading blank lines gone
 *  (blank: only spaces, tabs and CRs; the binary, for a cherry-pick and a rebase). */
function asPicked(raw: string): string {
  const lines = raw.split('\n');
  let i = 0;
  while (i < lines.length - 1 && /^[ \t\r]*$/.test(lines[i])) i++;
  return lines.slice(i).join('\n');
}

const isRebase = (s: SeqState) => s.kind === 'rebase';
const verb = (s: SeqState): 'cherry-pick' | 'revert' => (s.kind === 'revert' ? 'revert' : 'cherry-pick');
const reflogOf = (s: SeqState, message: string) => (isRebase(s) ? `rebase (pick): ` : `${verb(s)}: `) + reflogMessage(firstLine(message));

async function headNow(cx: WriteCx): Promise<string> {
  return (await worktreeOf(cx.read, cx.root)).head ?? fail('Other', 'HEAD has no commit');
}

async function save(cx: WriteCx, s: SeqState): Promise<void> {
  await writeSeq(cx.read, cx.gitdir, s);
  cx.touch('state');
}

/** HEAD (detached for a rebase; the branch for a pick) moves to `to`, the index and worktree with it;
 *  a refusal in `verb`'s words (a replayed commit's are a merge's). */
async function moveTo(cx: WriteCx, s: SeqState, to: string, reflog: string, verb: 'checkout' | 'merge' = 'checkout'): Promise<void> {
  if (to === s.head) return;
  await checkoutTree(cx, s.head, to, { verb });
  if (isRebase(s) || s.headName === null) await setHead(cx.read, cx.gitdir, { detached: to });
  else await cx.cas([{ name: s.headName, old: s.head, new: to }], reflog);
  s.head = to;
}

function commitOn(cx: WriteCx, c: { tree: string; parents: string[]; message: string; author?: string | Signature }): Promise<string> {
  return writeCommitObject(cx.read, c, cx.ctx);
}

function remap(s: SeqState, from: string, to: string): void {
  for (const k of Object.keys(s.map)) if (s.map[k] === from) s.map[k] = to;
}

async function messageOf(read: ReadRepo, s: SeqState, oid: string, given: string | undefined): Promise<string> {
  if (given !== undefined) return given;
  const raw = (await readCommit(read, oid)).rawMessage;
  return s.kind === 'revert' ? revertMessage(oid, firstLine(raw)) : asPicked(raw);
}

/** A replay's conflicts written into the index and the worktree (git's refusal first, when local
 *  changes are in their way); a pick's lists its paths, as git's message file does. */
async function conflictStop(cx: WriteCx, at: string, message: string, merged: MergeResult, o: { pick: boolean; parents?: string[]; how?: PickRefusal }): Promise<Stop> {
  await refuseMergeOver(cx, merged, o.how);
  await applyMerge(cx, '', merged);
  return { reason: 'conflict', at, message, ...(o.pick ? { conflicts: [...merged.conflicts].sort(compareBytewise) } : {}), ...(o.parents ? { parents: o.parents } : {}) };
}

/** The commits `s` made on its branch so far (a pick or revert sequence), first-parent. */
async function applied(cx: WriteCx, s: SeqState): Promise<number> {
  let n = 0;
  for (let at: string | undefined = s.head; at && at !== s.origHead && n <= s.done.length; at = (await readCommit(cx.read, at)).parents[0]) n++;
  return n;
}

/** A cherry-pick or revert that failed with nothing in progress (an empty revert, a pick refused
 *  over an untracked file): the core quits the sequence (sequence.rs), the commits that went in
 *  stay, and a sequence's error says how far it got. */
async function quit(cx: WriteCx, s: SeqState, e: unknown): Promise<never> {
  await clearSeq(cx.read, cx.gitdir);
  cx.touch('state');
  const err = asGbError(e);
  const total = s.done.length + s.todo.length;
  if (total <= 1) throw err;
  throw { ...err, message: `${trimEndRust(err.message)} (${await applied(cx, s)} of ${total} applied, the rest weren't)` };
}

/** UX L: the Edit row's commit `made` on `base`, then HEAD back on `base` ("about to commit": its
 *  changes staged, the row's message in the box). */
async function editStop(cx: WriteCx, s: SeqState, at: string, made: string, base: string, given: string | undefined): Promise<Stop> {
  const read = cx.read;
  await setHead(read, cx.gitdir, { detached: base });
  s.head = base;
  const tree = await treeOf(read, made);
  const added = (await diffTrees(read, await treeOf(read, base), tree)).filter((ch) => ch.old === null && ch.new !== null).map((ch) => ch.path);
  const madeFiles = [...(await listFiles(read, tree))].map(([p, e]): [string, string, number] => [p, e.oid, e.mode]);
  const message = given ?? (await readCommit(read, made)).rawMessage;
  return { reason: 'edit', at, message, made, editBase: base, added, madeFiles };
}

/** The core's reword script (irebase/todo.rs `reword_script`): HEAD's message amended in (`git
 *  commit -q --amend --only --allow-empty -F`, its whitespace cleanup, HEAD's author kept) only
 *  while HEAD's `%ae %at %s` is still the group's commit's; otherwise nothing (its target was
 *  skipped, or a message typed at a stop changed the subject). */
async function guardedAmend(cx: WriteCx, s: SeqState, a: Amend): Promise<void> {
  const head = await readCommit(cx.read, s.head);
  if (`${head.author.email} ${head.author.time} ${gitSubject(head.rawMessage)}` !== a.guard) return;
  const made = await commitOn(cx, { tree: head.tree, parents: head.parents, message: cleanupWhitespace(a.message), author: await authorOf(cx.read, s.head) });
  await setHead(cx.read, cx.gitdir, { detached: made });
  remap(s, s.head, made);
  s.head = made;
}

/** One step; a stop, or null when it applied. */
async function apply(cx: WriteCx, s: SeqState, step: Step): Promise<Stop | null> {
  const read = cx.read;
  switch (step.op) {
    case 'line':
      if (step.amend) await guardedAmend(cx, s, step.amend);
      return null;
    case 'updateRef':
      s.refsAfter[step.ref] = s.head;
      return null;
    case 'pick': {
      const c = await readCommit(read, step.oid);
      const base = step.parent === null ? s.head : (s.map[step.parent] ?? s.onto);
      if (base !== s.head) await moveTo(cx, s, base, `rebase (reset): ${short(base)}`);
      // git fast-forwards over a commit already on its new base (an Edit row's too: its new
      // message is the stop's, not a reword).
      if (isRebase(s) && c.parents[0] === base && (step.message === undefined || step.edit)) {
        await moveTo(cx, s, step.oid, reflogOf(s, c.rawMessage));
        s.map[step.oid] = step.oid;
        return step.edit ? editStop(cx, s, step.oid, step.oid, base, step.message) : null;
      }
      const baseTree = await treeOf(read, base);
      const merged = await replay(read, step.oid, baseTree, s.kind === 'revert' ? 'revert' : 'pick');
      const message = await messageOf(read, s, step.oid, step.message);
      // A cherry-pick or revert's refusal is git's own for it, not a merge's.
      if (merged.tree === null) return conflictStop(cx, step.oid, message, merged, { pick: true, ...(isRebase(s) ? {} : { how: { op: verb(s), noCommit: false } }) });
      // A commit that started empty stays in a rebase (git's default); one that became empty
      // drops or stops; a revert's fails (git stops for none).
      const startedEmpty = c.tree === (c.parents.length > 0 ? await treeOf(read, c.parents[0]) : null);
      if (merged.tree === baseTree && !(isRebase(s) && startedEmpty)) {
        if (s.kind === 'revert') throw gitFailure(GIT_EXITED, '');
        if (s.empty === 'drop') {
          s.map[step.oid] = base;
          return null;
        }
        return { reason: 'empty', at: step.oid, message, error: EMPTY_PICK };
      }
      const author = s.kind === 'revert' ? undefined : await authorOf(read, step.oid);
      // An Edit row's new message is its stop's (the box's), not a reword: git commits the original.
      const kept = step.edit && step.message !== undefined ? await messageOf(read, s, step.oid, undefined) : message;
      const made = await commitOn(cx, { tree: merged.tree, parents: [base], message: kept, author });
      await moveTo(cx, s, made, reflogOf(s, kept), 'merge');
      s.map[step.oid] = made;
      return step.edit ? editStop(cx, s, step.oid, made, base, step.message) : null;
    }
    case 'fold': {
      // git's fixup: HEAD amended with the commit's change, HEAD's author kept.
      const target = await readCommit(read, s.head);
      const merged = await replay(read, step.oid, target.tree, 'pick');
      const own = await readCommit(read, step.oid);
      const message = step.message ?? (step.fixup ? target.rawMessage : mergedMessage([target.rawMessage, own.rawMessage]));
      // The stop leaves HEAD on the commit the fold amends (git's `amend` stop).
      if (merged.tree === null) return conflictStop(cx, step.oid, message, merged, { pick: false });
      const made = await commitOn(cx, { tree: merged.tree, parents: target.parents, message, author: await authorOf(read, s.head) });
      const was = s.head;
      await checkoutTree(cx, target.tree, merged.tree, { verb: 'merge' });
      await setHead(read, cx.gitdir, { detached: made });
      s.head = made;
      remap(s, was, made);
      s.map[step.oid] = made;
      return null;
    }
    case 'merge': {
      if (step.parents.length !== 2) fail('Other', 'Not in the demo: rebasing an octopus merge');
      const c = await readCommit(read, step.oid);
      const parents = step.parents.map((p, i) => s.map[p] ?? (i === 0 ? s.onto : p));
      if (parents.every((p, i) => p === c.parents[i])) {
        await moveTo(cx, s, step.oid, `rebase (merge): ${reflogMessage(firstLine(c.rawMessage))}`);
        s.map[step.oid] = step.oid;
        return null;
      }
      await moveTo(cx, s, parents[0], `rebase (reset): ${short(parents[0])}`);
      // Its other side is already in (a merged-in line the target had whole): git's merge is
      // "already up to date" and makes nothing.
      if ((await ancestors(read, parents[0])).has(parents[1])) {
        s.map[step.oid] = parents[0];
        return null;
      }
      const base = await mergeBaseOf(read, parents[0], parents[1]);
      const merged = await mergeTrees(read, {
        base: base ? await treeOf(read, base) : null, ours: await treeOf(read, parents[0]), theirs: await treeOf(read, parents[1]),
        labels: { ours: 'HEAD', theirs: short(parents[1]), base: base ? short(base) : 'empty tree' },
      });
      if (merged.tree === null) return conflictStop(cx, step.oid, c.rawMessage, merged, { pick: false, parents });
      const made = await commitOn(cx, { tree: merged.tree, parents, message: c.rawMessage, author: await authorOf(read, step.oid) });
      await moveTo(cx, s, made, `rebase (merge): ${reflogMessage(firstLine(c.rawMessage))}`, 'merge');
      s.map[step.oid] = made;
      return null;
    }
  }
}

async function conflicted(cx: WriteCx): Promise<number> {
  return conflictedIn(demoOf(cx.read).fs, cx.gitdir);
}

async function stopped(cx: WriteCx, s: SeqState, stop: Stop): Promise<SeqEnd> {
  // UX N: what the step left at a stop it just made, which an interactive rebase's Abort doesn't
  // keep. A stop with the key of the last one noted (its last done line: a rescheduled step refused
  // again, a finish refused again) isn't one: the visitor's work there stays theirs (Before::made).
  if (isRebase(s) && s.interactive) {
    const key = JSON.stringify(s.done.at(-1) ?? null);
    stop.left = s.noted?.key === key ? s.noted.left : await noteStop(cx);
    s.noted = { key, left: stop.left };
  }
  s.stop = stop;
  await save(cx, s);
  return { status: 'stopped', stop, files: await conflicted(cx) };
}

/** What the core marks changed once git ran (`run_rebase_stop`, `run_sequence`): everything but
 *  config and stashes, whatever git did; a Continue, Skip or Abort of a pick leaves `refs` out
 *  (pick.rs). */
function gitRan(cx: WriteCx, s: SeqState): void {
  for (const k of ['worktree', 'index', 'head', 'state'] as const) cx.touch(k);
  if (isRebase(s)) cx.touch('refs');
}

/** The core's rebase progress tap: git prints a step line as it starts each todo line, and the
 *  last tick reloads the graph when HEAD has moved since the write began (`head_ticker`). */
async function lastTick(cx: WriteCx, s: SeqState, stepped: boolean): Promise<void> {
  if (isRebase(s) && stepped && (await worktreeOf(cx.read, cx.root)).head !== cx.before.head.oid) refsTick(cx);
}

async function run(cx: WriteCx, s: SeqState, own = false): Promise<SeqEnd> {
  const end = await steps(cx, s, own);
  await lastTick(cx, s, end.stepped);
  return end.end;
}

async function steps(cx: WriteCx, s: SeqState, own: boolean): Promise<{ end: SeqEnd; stepped: boolean }> {
  const branch = s.headName === null ? undefined : shortRef(s.headName);
  let stepped = false;
  while (s.todo.length > 0) {
    // The cancel point (the core's rebase.rs): a Cancel of a rebase it started aborts it, so the
    // repository is as it was; a Cancel of a Continue or Skip leaves the rebase paused where it
    // stands (the visitor's resolutions stay). Cherry-picks and reverts have none there.
    if (isRebase(s) && cx.opHandle.cancelled()) {
      if (own) await abortSeq(cx, 'rebase');
      throw gbError('Cancelled', 'Cancelled');
    }
    stepped = true;
    // A step joins `done` before it's applied (git's `msgnum`).
    const step = s.todo.shift()!;
    s.done.push(step);
    let stop: Stop | null;
    try {
      stop = await apply(cx, s, step);
    } catch (e) {
      if (!isRebase(s)) return quit(cx, s, e);
      const err = asGbError(e);
      if (err.kind === 'Cancelled' || !('oid' in step)) throw e;
      // git reschedules a pick it refused before changing anything (its line stays done and goes
      // back on top of the todo): the rebase stops there, and Continue retries it.
      s.todo.unshift(step);
      stop = { reason: 'refused', at: step.oid, message: '', error: err.message };
    }
    if (isRebase(s)) {
      const [n, m] = [s.done.length, s.total];
      cx.ctx.emit({ type: 'opProgress', op: cx.op, phase: 'Rebasing', percent: Math.min(100, Math.floor((100 * n) / Math.max(1, m))), step: { n, m, ...(branch ? { branch } : {}) } });
    }
    if (stop) return { end: await stopped(cx, s, stop), stepped };
    await save(cx, s);
  }
  return { end: await finish(cx, s), stepped };
}

/** The chips marked delete, once the rebase completed (the core's `delete_chips`): one already gone
 *  is skipped, one that moved or is checked out is kept (the warning names it). */
async function deleteChips(cx: WriteCx, s: SeqState, moves: RefMove[]): Promise<string | null> {
  const kept: string[] = [];
  const out = await listWorktrees(cx.read);
  for (const [name, tip] of Object.entries(s.deletes).sort(([a], [b]) => compareBytewise(a, b))) {
    const now = readRef(demoOf(cx.read), name);
    if (now === null) continue;
    if (now !== tip || out.some((w) => w.branch === name)) {
      kept.push(shortRef(name));
      continue;
    }
    const gone: RefMove = { name, old: tip, new: null };
    await cx.cas([gone], `branch: deleted ${shortRef(name)}`);
    const changes = removeBranchConfig(cx.read, shortRef(name));
    if (!recordOnPaused(cx, [gone], changes)) cx.recordConfig(changes);
    moves.push(gone);
  }
  if (kept.length === 0) return null;
  return kept.length === 1 ? `${kept[0]} wasn't deleted: it changed during the rebase` : `${kept.join(', ')} weren't deleted: they changed during the rebase`;
}

/** git's refusal of a ref it can't move to `next` (`update_ref failed …`): the ref isn't at `old`. */
const updateRefFailed = (name: string, now: string | null, old: string | null) =>
  `update_ref failed for ref '${name}': cannot lock ref '${name}': is at ${now ?? ZERO} but expected ${old ?? ZERO}`;
const ZERO = '0'.repeat(40);

/** Finish (a rebase): the branch moves to the new tip, then the chips the update-ref steps moved
 *  (recorded on the paused session, as the core's Continue records them), HEAD back on the branch,
 *  the chips marked delete deleted. A ref that moved meanwhile isn't moved: git moves the rest,
 *  names it and stays in progress (as the binary does), so the finish stops on it. A pick or revert
 *  moved its branch as it went. */
async function finish(cx: WriteCx, s: SeqState): Promise<SeqEnd> {
  const moves: RefMove[] = [];
  let warning: string | null = null;
  if (isRebase(s)) {
    const demo = demoOf(cx.read);
    if (s.headName !== null) {
      const now = readRef(demo, s.headName);
      if (now !== s.origHead) return stopped(cx, s, { reason: 'refused', at: '', message: '', error: updateRefFailed(s.headName, now, s.origHead) });
      const main: RefMove = { name: s.headName, old: s.origHead, new: s.head };
      gitMovesRefs(cx, [main]);
      await setHead(cx.read, cx.gitdir, { branch: s.headName });
      moves.push(main);
    }
    const failed: string[] = [];
    const updates: RefMove[] = [];
    for (const [name, to] of Object.entries(s.refsAfter)) {
      const old = s.refsBefore[name] ?? null;
      if (old === to) continue;
      const now = readRef(demo, name);
      if (now !== old) {
        failed.push(updateRefFailed(name, now, old));
        continue;
      }
      updates.push({ name, old, new: to });
    }
    if (updates.length > 0) gitMovesRefs(cx, updates);
    moves.push(...updates);
    recordOnPaused(cx, updates, []);
    if (failed.length > 0) {
      // The branch stays moved (Abort puts it back, as git's does).
      return stopped(cx, s, { reason: 'refused', at: '', message: '', error: failed[0] });
    }
    warning = await deleteChips(cx, s, moves);
  }
  await clearSeq(cx.read, cx.gitdir);
  cx.touch('state');
  return { status: 'done', head: s.head, moves, ...(warning ? { warning } : {}) };
}

export async function startSeq(cx: WriteCx, start: SeqStart): Promise<SeqEnd> {
  const s: SeqState = {
    version: 1, kind: start.kind, headName: start.headName, origHead: start.origHead, onto: start.onto, target: start.target, interactive: start.interactive,
    todo: [...start.steps], done: [], total: start.steps.length, head: start.origHead, map: { ...start.map }, range: start.range,
    refsAfter: {}, refsBefore: start.refsBefore, deletes: start.deletes, empty: start.empty, stop: null, picked: start.kind === 'rebase' ? [] : [...start.range],
  };
  gitRan(cx, s);
  cx.touch('refs');
  if (isRebase(s)) {
    await checkoutTree(cx, s.origHead, s.onto);
    writeOrigHead(cx, s.origHead);
    await setHead(cx.read, cx.gitdir, { detached: s.onto });
    s.head = s.onto;
  }
  await save(cx, s);
  return run(cx, s, true);
}

/** What a control acts on: the commit panel's rebase (`rebaseControl`) or pick (`pickControl`). */
export type SeqWhich = 'rebase' | 'pick';

/** The sequence `which` names, or the core's refusal (rebase.rs, pick.rs). */
async function current(cx: WriteCx, which: SeqWhich): Promise<SeqState> {
  const s = await readSeq(cx.read, cx.gitdir);
  if (s === null || isRebase(s) !== (which === 'rebase')) fail('InvalidInput', which === 'rebase' ? 'No rebase is in progress' : 'No cherry-pick or revert is in progress');
  return s;
}

/** Retry the step git rescheduled when it refused it (its line counts again, as git's `end`), or the
 *  finish that couldn't move a ref. */
async function retry(cx: WriteCx, s: SeqState, stop: Stop): Promise<SeqEnd> {
  if (stop.at !== '') s.total += 1;
  s.stop = null;
  await save(cx, s);
  return run(cx, s);
}

/** Continue at an Edit stop (the core's `commit_at_stop`): refused while tracked changes are
 *  unstaged or a file of the commit is left untracked; then HEAD goes back to the stop's commit
 *  when nothing changed there, or what's staged is committed with `message` (the box's; blank:
 *  the stop's), the original's author kept, or nothing is left to commit. The new HEAD. */
async function continueAtEdit(cx: WriteCx, stop: Stop, message: string | undefined): Promise<string> {
  const read = cx.read;
  const made = stop.made!;
  if ((await statusEntries(read, cx.root)).some((e) => e.kind !== 'untracked' && e.worktree !== '.')) fail('InvalidInput', COMMIT_OR_DISCARD);
  const head = await headNow(cx);
  const indexed = new Set((await readIndexEntries(read, cx.gitdir)).map((e) => e.path));
  const inHead = await listFiles(read, head);
  for (const p of [...(await listFiles(read, made)).keys()].sort(compareBytewise)) {
    if (!indexed.has(p) && !inHead.has(p) && (await lstatOrNull(read, `${cx.root}/${p}`)) !== null) fail('InvalidInput', notStaged(p));
  }
  const tree = await writeTreeFromIndex(read, cx.gitdir);
  const madeTree = await treeOf(read, made);
  const changed = tree !== madeTree;
  const staged = tree !== (await treeOf(read, head));
  const box = message !== undefined && trimEndRust(message) !== '' ? message : stop.message;
  const text = `${trimEndRust(box.replaceAll('\r\n', '\n'))}\n`;
  const onBase = head === stop.editBase;
  const own = (await readCommit(read, made)).rawMessage;
  if (onBase && !changed && trimEndRust(own.replaceAll('\r\n', '\n')) === trimEndRust(text)) {
    await setHead(read, cx.gitdir, { detached: made });
    return made;
  }
  const empty = onBase && madeTree === (await treeOf(read, stop.editBase!));
  if (!staged && !empty) return head;
  // `git commit -F -`: its whitespace cleanup.
  const next = await commitOn(cx, { tree, parents: [head], message: cleanupWhitespace(text), author: await authorOf(read, made) });
  await setHead(read, cx.gitdir, { detached: next });
  // Work done at the stop: settle's completion check and an Abort's kept work read it.
  notePaused(cx, (ir) => void ir.made.push(next));
  return next;
}

export async function continueSeq(cx: WriteCx, message: string | undefined, which: SeqWhich): Promise<SeqEnd> {
  const s = await current(cx, which);
  const stop = s.stop;
  // At an Edit stop the core refuses before git runs (irebase/edit.rs): nothing of git's changed then.
  if (stop?.reason !== 'edit') gitRan(cx, s);
  if (!stop) return run(cx, s);
  if (stop.reason === 'refused') return retry(cx, s, stop);
  if (stop.reason === 'edit') {
    const head = await continueAtEdit(cx, stop, message);
    gitRan(cx, s);
    s.head = head;
    s.map[stop.at] = head;
  } else {
    // Unresolved conflicts: git refuses and the stop stands (the core reports it stopped again).
    if ((await conflicted(cx)) > 0) return { status: 'stopped', stop, files: await conflicted(cx) };
    const step = s.done[s.done.length - 1];
    const tree = await writeTreeFromIndex(cx.read, cx.gitdir);
    // git commits a stop's message with its strip cleanup (the `# Conflicts:` block goes).
    const text = cleanupStrip(message ?? stop.message);
    if (step.op === 'fold') {
      const target = await readCommit(cx.read, s.head);
      const made = await commitOn(cx, { tree, parents: target.parents, message: text, author: await authorOf(cx.read, s.head) });
      await setHead(cx.read, cx.gitdir, { detached: made });
      remap(s, s.head, made);
      s.head = made;
      s.map[step.oid] = made;
    } else if (tree === (await treeOf(cx.read, s.head)) && step.op !== 'merge') {
      // Nothing left: a rebase drops it; a cherry-pick or revert stays stopped (the binary).
      if (!isRebase(s)) return stopped(cx, s, { ...stop, reason: 'empty', error: s.kind === 'revert' ? GIT_EXITED : EMPTY_PICK });
      s.map[stop.at] = s.head;
    } else {
      const author = s.kind === 'revert' ? undefined : await authorOf(cx.read, stop.at);
      const parents = stop.parents ?? [s.head];
      const made = await commitOn(cx, { tree, parents, message: text, author });
      if (isRebase(s) || s.headName === null) await setHead(cx.read, cx.gitdir, { detached: made });
      else await cx.cas([{ name: s.headName, old: s.head, new: made }], `${s.kind === 'revert' ? 'commit' : 'commit (cherry-pick)'}: ${reflogMessage(firstLine(text))}`);
      s.head = made;
      s.map[stop.at] = made;
    }
  }
  s.stop = null;
  await save(cx, s);
  return run(cx, s);
}

export async function skipSeq(cx: WriteCx, which: SeqWhich): Promise<SeqEnd> {
  const s = await current(cx, which);
  if (s.stop?.reason === 'edit') fail('InvalidInput', "Skip isn't offered at an Edit stop: discard its changes to leave the commit out, then Continue");
  gitRan(cx, s);
  await checkoutTree(cx, s.head, s.head, { force: true });
  // A rescheduled step has nothing to skip: git runs it again (the binary).
  if (s.stop?.reason === 'refused') return retry(cx, s, s.stop);
  if (s.stop) s.map[s.stop.at] = s.head;
  s.stop = null;
  await save(cx, s);
  return run(cx, s);
}

export async function abortSeq(cx: WriteCx, which: SeqWhich): Promise<Aborted> {
  const s = await current(cx, which);
  const now = await headNow(cx);
  // An Abort of GitVolt's interactive rebase keeps the work done at its stops first, at any stop
  // (the core's `keep_work`): new commits on a work branch, new edits in a stash.
  const session = isRebase(s) && s.interactive ? pausedSession(cx) : null;
  // git's refusal over an untracked file in the way comes first: nothing is kept or reset then.
  if (isRebase(s)) await clearLeftovers(cx, s.origHead, session !== null);
  const kept = session === null ? null : await keepWork(cx, s, now, session);
  // git's `--abort` ran (rebase.rs, pick.rs): refs only as the moves say.
  for (const k of ['worktree', 'index', 'head', 'state'] as const) cx.touch(k);
  await checkoutTree(cx, now, s.origHead, { force: true });
  if (isRebase(s) || s.headName === null) {
    // A finish that stopped on a chip had moved the branch already: it goes back, as git's.
    const tip = s.headName === null ? null : readRef(demoOf(cx.read), s.headName);
    if (s.headName !== null && tip !== s.origHead) await cx.cas([{ name: s.headName, old: tip, new: s.origHead }], 'rebase (abort): returning to the original tip');
    if (s.headName !== null) await setHead(cx.read, cx.gitdir, { branch: s.headName });
    else await setHead(cx.read, cx.gitdir, { detached: s.origHead });
  } else if (now !== s.origHead) await cx.cas([{ name: s.headName, old: now, new: s.origHead }], `${inProgressWord(s.kind)}: abort`);
  await clearSeq(cx.read, cx.gitdir);
  cx.touch('state');
  if (kept !== null) finishKeptWork(cx, kept);
  return { stash: kept?.stash ?? null, branch: kept?.branch ?? null };
}
