// Undo and redo (journal/undo.rs, spec #2 §5.3–§5.4, UX Y): writes of their own that move an entry
// between the stacks, replaying the recorded effect (a CAS, a snapshot, a switch), never the
// command. An out-of-order undo is an entry of its own, in the undone one's place. Not here: the
// core's repository-in-the-way checks and `restore_in_the_way`'s untracked files (no fixture has a
// nested repository where a restore writes) and removed remotes (plan 4).
import type { MovedRef } from '../../api/gen/MovedRef';
import type { UndoOutcome } from '../../api/gen/UndoOutcome';
import type { HandlerTable } from '../transport';
import { gbError } from '../engine/errors';
import { compareBytewise } from '../engine/read/bytes';
import { readCommit } from '../engine/read/commitText';
import { relation } from '../engine/read/revs';
import { fail } from '../engine/read/seam';
import { diffTrees } from '../engine/read/trees';
import { listWorktrees } from '../engine/read/worktrees';
import type { AutostashSpec } from '../engine/write/autostash';
import { applyConfigChanges, branchConfig, type ConfigChange } from '../engine/write/config';
import { firstOverlap, sameHead, type JournalEntry } from '../engine/write/journal';
import { checkRemovedRemote, replaySymrefs } from '../engine/write/removedRemote';
import { twoWayMove } from '../engine/write/move';
import { readHead, readRef, refMoved, setHead, shortRef, type HeadState, type RefMove } from '../engine/write/refs';
import { runWrite, type Pre, type WriteCx, type WriteIntent } from '../engine/write/run';
import { writeTarget, type WriteWt } from '../engine/write/seam';
import { changedSince, createSnapshot, onlyPaths, restoreSnapshot, untrackedAmong, type Snapshot } from '../engine/write/snapshot';
import { dirty } from '../engine/write/status';
import { heads, renameBranchRefs } from './branches';
import { stagedSince, twoWayIndex, undoReset } from './reset';
import { NO_EXPECT } from './stage';
import { undoStash } from './stash';

export type Direction = 'undo' | 'redo';

interface Ask {
  dir: Direction;
  /** The entry as the request found it (a copy): the run checks the journal still holds it unchanged. */
  entry: JournalEntry;
  confirm: Record<string, string | null>;
  autostashOk: boolean;
  withoutIndex: boolean;
  outOfOrder: boolean;
  /** "Undo the stopped cherry-pick?" was confirmed: its changes are discarded. */
  confirmDiscard: boolean;
}

const stale = () => gbError('Stale', 'The undo history changed; refreshed');
const RESETS = ['resetSoft', 'resetMixed', 'resetHard'];
const headValue = (h: HeadState) => (h.branch !== null ? `refs/heads/${h.branch}` : h.oid);
const has = (o: Record<string, string | null>, k: string) => Object.prototype.hasOwnProperty.call(o, k);
const reversed = (moves: RefMove[]): RefMove[] => moves.map((m) => ({ name: m.name, old: m.new, new: m.old }));

/** Deep equality over an entry's values (arrays, maps, bytes, plain objects): the core's `==`. */
function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (a instanceof Uint8Array || b instanceof Uint8Array) return a instanceof Uint8Array && b instanceof Uint8Array && a.length === b.length && a.every((x, i) => x === b[i]);
  if (a instanceof Map || b instanceof Map) {
    if (!(a instanceof Map && b instanceof Map) || a.size !== b.size) return false;
    for (const [k, v] of a) if (!b.has(k) || !sameValue(v, b.get(k))) return false;
    return true;
  }
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const [ka, kb] = [Object.keys(a), Object.keys(b)];
  return ka.length === kb.length && ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && sameValue((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

/** A recorded move's (from, to) in this direction. */
const ends = (a: Ask, m: RefMove): [string | null, string | null] => (a.dir === 'undo' ? [m.new, m.old] : [m.old, m.new]);
const snapshotOf = (a: Ask): Snapshot | null => (a.dir === 'undo' ? a.entry.before : a.entry.after);
const leftOf = (a: Ask): Snapshot | null => (a.dir === 'undo' ? a.entry.after : a.entry.before);
const headEnds = (a: Ask): [HeadState, HeadState] => (a.dir === 'undo' ? [a.entry.headAfter, a.entry.headBefore] : [a.entry.headBefore, a.entry.headAfter]);
/** The undo of a "without committing" pick that stopped on conflicts: it discards P, unmerged paths
 *  included, after its own question. */
const stoppedPick = (a: Ask) => (a.dir === 'undo' && a.entry.undo === 'restore' ? a.entry.stoppedPick : null);
const detachedReset = (a: Ask) => RESETS.includes(a.entry.undo) && a.entry.headBefore.branch === null;

/** HEAD where this direction doesn't start: a prompt row, a refusal, or null. */
function headMoved(a: Ask, now: HeadState): MovedRef | null {
  // A discard's or a pop's snapshot restored over another commit asks, never refuses; HEAD stays.
  const snapshotRestore = a.entry.undo === 'restore' || (a.entry.undo === 'stash' && snapshotOf(a) !== null);
  if (snapshotRestore) {
    if (a.outOfOrder) return null;
    const [from] = headEnds(a);
    if (sameHead(from, now)) return null;
    const [want, have] = from.branch === now.branch ? [from.oid, now.oid] : [headValue(from), headValue(now)];
    if (has(a.confirm, 'HEAD')) {
      if (a.confirm.HEAD === have) return null;
      throw refMoved('HEAD');
    }
    return { name: 'HEAD', expected: want, actual: have, target: have, dropped: 0, stays: true };
  }
  const movesHead = a.entry.undo === 'moveHead' || detachedReset(a);
  if (a.entry.undo !== 'switch' && !movesHead) return null;
  const [from, to] = headEnds(a);
  const [want, have] = [headValue(from), headValue(now)];
  if (want === have) return null;
  // On a branch now, moving HEAD alone would leave that branch's files under another commit.
  if (movesHead && now.branch !== null) {
    const back = from.oid?.slice(0, 7) ?? 'the detached commit';
    fail('InvalidInput', `HEAD is on ${now.branch} now: switch back to ${back} to ${a.dir} ${a.entry.label}`);
  }
  if (has(a.confirm, 'HEAD')) {
    if (a.confirm.HEAD === have) return null;
    throw refMoved('HEAD');
  }
  return { name: 'HEAD', expected: want, actual: have, target: headValue(to), dropped: 0, stays: false };
}

type Stacks = { undoTop(): JournalEntry | null; redoTop(): JournalEntry | null };

function onTop(j: Stacks, a: Ask): boolean {
  return (a.dir === 'undo' ? j.undoTop() : j.redoTop())?.id === a.entry.id;
}

/** `run` will change nothing (stale, or a ref or HEAD that asks first): no autostash for it. */
function changesNothing(wt: WriteWt, a: Ask, head: HeadState, j: Stacks): boolean {
  if (!a.outOfOrder && !onTop(j, a)) return true;
  try {
    if (headMoved(a, head) !== null) return true;
  } catch {
    return true;
  }
  return a.entry.refs.some((m) => {
    const now = readRef(wt.demo, m.name);
    return now !== ends(a, m)[0] && !(has(a.confirm, m.name) && a.confirm[m.name] === now);
  });
}

const paths = (op: string, list: string[]): AutostashSpec | undefined => (list.length > 0 ? { rule: { kind: 'paths', paths: list }, target: null, op, targetName: op } : undefined);

/** Why an out-of-order undo is refused: the history changed (Stale), or a later action depends on it. */
const dependent = (why: string) => (why.startsWith('The undo history changed') ? gbError('Stale', why) : gbError('InvalidInput', why));

/** The out-of-order undo's CAS, before anything is written: still independent and the same entry,
 *  and what it changed still as it left it (paths, refs, config, HEAD's tree under its paths). */
async function outOfOrderCheck(pre: Pre, a: Ask): Promise<void> {
  const e = a.entry;
  const found = pre.ctx.writes.journal(pre.wt.root).outOfOrder(e.id, null);
  if ('why' in found) throw dependent(found.why);
  if (!sameValue(found.entry, e)) throw stale();
  const changed = (what: string) => gbError('Stale', `${what} changed since ${e.label}; it can't be undone out of order`);
  if (e.undo === 'restore' && pre.before.head.oid !== e.headAfter.oid) {
    if (e.headAfter.oid === null || pre.before.head.oid === null) throw changed('HEAD');
    const moved = new Set((await diffTrees(pre.wt.repo, e.headAfter.oid, pre.before.head.oid)).map((c) => c.path));
    const mine = new Set([...(e.after?.paths ?? []), ...(e.before?.paths ?? [])]);
    const p = firstOverlap(mine, moved);
    if (p !== null) throw gbError('Stale', `HEAD changed ${p} since ${e.label}; it can't be undone out of order`);
  }
  if (e.after) {
    const p = (await changedSince(pre.wt, e.after))[0];
    if (p !== undefined) throw changed(p);
  }
  for (const m of e.refs) if (readRef(pre.wt.demo, m.name) !== m.new) throw changed(shortRef(m.name));
  for (const c of e.config) {
    const name = /^branch\.(.+)\.[^.]+$/.exec(c.key)?.[1] ?? '';
    const now = branchConfig(pre.wt.demo, name).get(c.key) ?? [];
    if (now.length !== c.new.length || now.some((v, i) => v !== c.new[i])) throw changed(c.key);
  }
  const worktrees = await listWorktrees(pre.wt.repo);
  for (const m of e.refs.filter((x) => x.name.startsWith('refs/heads/'))) {
    for (const w of worktrees.filter((x) => x.branch === m.name)) {
      if (w.path !== pre.wt.root) fail('InvalidInput', `${shortRef(m.name)} is checked out in ${w.path}`);
      if (m.old === null) fail('InvalidInput', `${shortRef(m.name)} is checked out: switch away from it to undo ${e.label}`);
    }
  }
}

/** §6.1: Switch and Rewind autostash on overlap with the commit they move to; a snapshot restore
 *  and a reset's undo on the paths they overwrite that changed since. */
async function planOf(pre: Pre, a: Ask): Promise<{ autostash?: AutostashSpec; snapshot?: { paths: string[]; untracked: string[] } }> {
  if (a.outOfOrder) await outOfOrderCheck(pre, a);
  if (changesNothing(pre.wt, a, pre.before.head, pre.ctx.writes.journal(pre.wt.root))) return {};
  const label = `${a.dir} ${a.entry.label}`;
  const e = a.entry;
  const here = pre.before.head.branch === e.headBefore.branch && e.headBefore.oid !== null && pre.before.head.oid !== null;
  let autostash: AutostashSpec | undefined;
  switch (e.undo) {
    case 'switch': {
      const h = a.dir === 'undo' ? e.headBefore : e.headAfter;
      autostash = { rule: { kind: 'overlap' }, target: h.oid, op: label, targetName: h.branch ?? h.oid };
      break;
    }
    case 'rewind': {
      const m = e.refs.find((x) => pre.before.head.branch !== null && x.name === heads(pre.before.head.branch));
      if (m) autostash = { rule: { kind: 'overlap' }, target: ends(a, m)[1], op: label, targetName: pre.before.head.branch };
      break;
    }
    case 'restore': {
      const s = snapshotOf(a);
      if (!s) break;
      // A stopped pick asks, and its changes (P) aren't autostashed.
      const stopped = stoppedPick(a);
      if (stopped) {
        if (!a.confirmDiscard) {
          const arm = `Click again to undo: discards the stopped ${stopped.op}'s changes`;
          throw { ...gbError('Conflict', `Undo the stopped ${stopped.op}? Its changes are discarded, including anything you resolved since.`), detail: { kind: 'undoStoppedPick', op: stopped.op, arm } };
        }
        break;
      }
      const p = (await dirty(pre.wt.repo, pre.wt.root)).unmerged.find((x) => s.paths.includes(x));
      if (p !== undefined) fail('InProgress', `${p} has merge conflicts: resolve conflicts first`);
      // Out of order, a change to P is refused (the check above, and again before the restore).
      const left = leftOf(a);
      autostash = paths(label, a.outOfOrder ? [] : left ? await changedSince(pre.wt, left) : s.paths);
      break;
    }
    case 'resetHard':
      if (a.dir === 'undo' && here) {
        const list = new Set([...(e.before?.paths ?? []), ...(await diffTrees(pre.wt.repo, pre.before.head.oid, e.headBefore.oid)).map((c) => c.path)]);
        autostash = paths(label, [...list].sort(compareBytewise));
      }
      break;
    case 'resetMixed':
      if (a.dir === 'undo' && here) autostash = paths(label, await stagedSince(pre.wt, pre.before.head.oid!, e.headBefore.oid!, e.before));
      break;
    case 'stash':
      // A pop's undo restores `before` over P; a conflicting pop has no `after`.
      if (a.dir === 'undo' && e.before) {
        if (e.after) autostash = paths(label, await changedSince(pre.wt, e.after));
        else {
          if ((await dirty(pre.wt.repo, pre.wt.root)).conflicted > 0) fail('InvalidInput', 'Resolve or abort the conflicts first');
          autostash = paths(label, e.before.paths);
        }
      }
      break;
    default:
      break;
  }
  // An out-of-order restore's own entry snapshots P first, as any destructive write does.
  let snapshot: { paths: string[]; untracked: string[] } | undefined;
  if (a.outOfOrder && e.undo === 'restore' && e.before && e.after) {
    const all = [...new Set([...e.before.paths, ...e.after.paths])].sort(compareBytewise);
    snapshot = { paths: all, untracked: await untrackedAmong(pre.wt, all) };
  }
  return { ...(autostash ? { autostash } : {}), ...(snapshot ? { snapshot } : {}) };
}

/** MoveHead: HEAD itself, from where this step starts (or the value "Undo anyway" showed). */
function moveHeadOnly(cx: WriteCx, a: Ask): void {
  const [from, to] = headEnds(a);
  const old = has(a.confirm, 'HEAD') && a.confirm.HEAD !== null ? a.confirm.HEAD : from.oid;
  if (old === null || to.oid === null) fail('Other', 'nothing to move HEAD to');
  if (readHead(cx.wt).oid !== old) throw refMoved('HEAD');
  setHead(cx.wt, { oid: to.oid });
  cx.touch('head');
}

/** Rewind: `read-tree -m -u` from the checked-out branch's tip to its target, then the CAS (the
 *  reverse read-tree if that fails). */
async function rewind(cx: WriteCx, moves: RefMove[]): Promise<void> {
  const branch = cx.before.head.branch;
  const m = moves.find((x) => branch !== null && x.name === heads(branch));
  if (!m || m.old === null || m.new === null) {
    cx.cas(moves);
    return;
  }
  await twoWayMove(cx.wt, m.old, m.new, 'readTree');
  cx.touch('worktree');
  cx.touch('index');
  try {
    cx.cas(moves);
  } catch (e) {
    await twoWayMove(cx.wt, m.new, m.old, 'readTree').catch(() => undefined);
    throw e;
  }
}

/** Switch: HEAD and the worktree back (undo, then the CAS) or again (redo: the CAS first, put back
 *  if the switch fails). */
async function switchTo(cx: WriteCx, a: Ask, moves: RefMove[]): Promise<void> {
  const h = a.dir === 'undo' ? a.entry.headBefore : a.entry.headAfter;
  if (h.branch === null && h.oid === null) fail('Other', 'nothing to switch to');
  if (a.dir === 'redo') cx.cas(moves);
  try {
    const to = h.branch !== null ? readRef(cx.wt.demo, heads(h.branch)) : h.oid;
    if (to === null) fail('NotFound', `No branch ${h.branch}`);
    await twoWayMove(cx.wt, readHead(cx.wt).oid, to, 'checkout');
    setHead(cx.wt, h.branch !== null ? { branch: h.branch } : { oid: to });
  } catch (e) {
    if (a.dir === 'redo') cx.cas(reversed(moves));
    throw e;
  }
  for (const k of ['head', 'index', 'worktree'] as const) cx.touch(k);
  if (a.dir === 'undo') cx.cas(moves);
}

/** The rename's names: the deleted ref is the old name, the created one the new. */
async function rename(cx: WriteCx, a: Ask): Promise<void> {
  const name = (deleted: boolean) => a.entry.refs.find((m) => (deleted ? m.new === null : m.old === null))?.name.slice('refs/heads/'.length) ?? null;
  const [old, next] = [name(true), name(false)];
  if (old === null || next === null) fail('Other', "the rename's names aren't recorded");
  if (a.dir === 'undo') await renameBranchRefs(cx, next, old);
  else await renameBranchRefs(cx, old, next);
}

/** The kind's own step. */
async function replay(cx: WriteCx, a: Ask, moves: RefMove[]): Promise<void> {
  const e = a.entry;
  switch (e.undo) {
    case 'moveRefs':
      cx.cas(moves);
      return;
    case 'moveHead':
      moveHeadOnly(cx, a);
      return;
    case 'rewind':
      return rewind(cx, moves);
    case 'switch':
      return switchTo(cx, a, moves);
    case 'rename':
      return rename(cx, a);
    case 'restore': {
      const s = snapshotOf(a);
      if (!s) fail('Other', 'nothing to restore');
      const stopped = stoppedPick(a);
      // Only the attempted commits' paths: the rest of P belongs to commits that never ran.
      await restoreSnapshot(cx.wt, stopped ? onlyPaths(s, stopped.paths) : s, stopped !== null);
      cx.touch('worktree');
      cx.touch('index');
      cx.cas(moves);
      return;
    }
    case 'stash':
      return undoStash(cx, e, a.dir === 'undo', e.label, a.withoutIndex);
    case 'resetSoft':
    case 'resetMixed':
    case 'resetHard':
      return undoReset(cx, e, moves, a.dir === 'undo');
    case 'barrier':
      fail('InvalidInput', "Push can't be undone");
  }
}

function undoIntent(a: Ask): WriteIntent<UndoOutcome> {
  const label = `${a.dir} ${a.entry.label}`;
  return {
    kind: a.dir,
    label: () => label,
    // Not an entry of its own, except out of order: then one of the undone kind.
    undo: () => (a.outOfOrder ? a.entry.undo : null),
    refs: () => a.entry.refs.map((m) => m.name),
    confirm: { autostash: a.autostashOk },
    plan: (pre) => planOf(pre, a),
    run: async (cx) => {
      const j = cx.journal;
      const e = a.entry;
      const own = cx.entryId;
      let still: boolean;
      if (a.outOfOrder) {
        const f = j.outOfOrder(e.id, own);
        still = 'entry' in f && sameValue(f.entry, e);
      } else still = onTop(j, a);
      cx.journalChanged = true;
      if (!still) throw stale();
      if (e.undo === 'barrier') fail('InvalidInput', "Push can't be undone");
      if (e.blocked !== null) fail('InvalidInput', e.blocked);
      if (e.removedRemote) checkRemovedRemote(cx.wt.demo, e.removedRemote, e.config, a.dir === 'undo');
      // §5.4: a ref that isn't where the operation left it asks first.
      const moves: RefMove[] = [];
      const moved: MovedRef[] = [];
      for (const m of e.refs) {
        const now = readRef(cx.wt.demo, m.name);
        const [from, to] = ends(a, m);
        // A rename isn't confirmable: either name reused since refuses.
        if (e.undo === 'rename' && now !== from) throw gbError('Stale', `${e.label} can't be ${a.dir === 'undo' ? 'undone' : 'redone'}: ${shortRef(m.name)} has changed since`);
        if (now !== from) {
          if (has(a.confirm, m.name)) {
            if (a.confirm[m.name] !== now) throw refMoved(m.name);
          } else {
            const dropped = from !== null && now !== null ? (await relation(cx.wt.repo, now, from))[0] : 0;
            moved.push({ name: m.name, expected: from, actual: now, target: to, dropped, stays: false });
            continue;
          }
        }
        moves.push({ name: m.name, old: now, new: to });
      }
      const head = headMoved(a, cx.before.head);
      if (head) {
        if ((e.undo === 'moveHead' || detachedReset(a)) && head.expected !== null && head.actual !== null) head.dropped = (await relation(cx.wt.repo, head.actual, head.expected))[0];
        moved.push(head);
      }
      if (moved.length > 0) {
        if (a.outOfOrder) throw gbError('Stale', `${shortRef(moved[0].name)} moved since ${e.label}; it can't be undone out of order`);
        return { status: 'moved', label: e.label, refs: moved };
      }
      // Out of order, P is checked again just before the restore; from here the worktree may change.
      if (a.outOfOrder && e.undo === 'restore') {
        const p = e.after ? (await changedSince(cx.wt, e.after))[0] : undefined;
        if (p !== undefined) throw gbError('Stale', `${p} changed since ${e.label}; it can't be undone out of order`);
        cx.partial = true;
      }
      // "Stage all & commit": the index two-way first, while HEAD is where this step starts, so a
      // refusal changes nothing; read back if the kind's step then fails.
      let index: [string, string] | null = null;
      const [startHead] = headEnds(a);
      if (e.indexBefore !== null && sameHead(cx.before.head, startHead) && e.headAfter.oid !== null) {
        const after = e.indexAfter ?? (await readCommit(cx.wt.repo, e.headAfter.oid)).tree;
        index = a.dir === 'undo' ? [after, e.indexBefore] : [e.indexBefore, after];
        await twoWayIndex(cx.wt, index[0], index[1]);
        cx.touch('index');
      }
      try {
        await replay(cx, a, moves);
      } catch (err) {
        if (index) await twoWayIndex(cx.wt, index[1], index[0]).catch(() => undefined);
        throw err;
      }
      // Every kind replays the entry's `branch.<name>.*` changes (Deviation 10).
      if (e.config.length > 0) {
        if (a.outOfOrder) cx.recordConfig(e.config.map((c): ConfigChange => ({ key: c.key, old: c.new, new: c.old })));
        applyConfigChanges(cx.wt.demo, e.config, a.dir === 'undo');
        cx.touch('config');
      }
      if (e.removedRemote && replaySymrefs(cx.wt.demo, e.removedRemote, a.dir === 'undo')) cx.touch('refs');
      if (a.outOfOrder) {
        // The undone entry leaves the stack (no Redo); its undo's entry takes its place. Redo stays
        // when every redo entry is independent of it.
        cx.keepRedo = j.redoSurvives(e);
        const at = j.undo.findIndex((x) => x.id === e.id);
        if (at >= 0) {
          j.undo.splice(at, 1);
          const n = own === null ? -1 : j.undo.findIndex((x) => x.id === own);
          if (n >= 0) {
            const [mine] = j.undo.splice(n, 1);
            j.undo.splice(Math.min(at, j.undo.length), 0, mine);
          }
        }
        if (cx.snapshot) cx.after = await createSnapshot(cx.wt, cx.snapshot.paths, await untrackedAmong(cx.wt, cx.snapshot.paths));
      } else {
        j.shift(e.id, a.dir === 'undo');
        // An undone stopped pick has no `after` to redo to: it goes.
        if (stoppedPick(a)) j.dropEntry(e.id);
      }
      return e.note === null ? { status: 'done', label: e.label } : { status: 'done', label: e.label, note: e.note };
    },
  };
}

export const undoHandlers: Pick<HandlerTable, 'undo' | 'redo' | 'undoEntry'> = {
  undo: async ({ repo, worktree, entry, confirm, confirmAutostash, withoutIndex, confirmDiscard }, ctx) => {
    const wt = await writeTarget(ctx, repo, worktree);
    const e = ctx.writes.journal(wt.root).undoTop();
    if (e?.id !== entry) throw stale();
    return runWrite(ctx, repo, worktree, NO_EXPECT, undoIntent({ dir: 'undo', entry: structuredClone(e), confirm: confirm ?? {}, autostashOk: confirmAutostash === true, withoutIndex: withoutIndex === true, outOfOrder: false, confirmDiscard: confirmDiscard === true }));
  },
  redo: async ({ repo, worktree, entry, confirmAutostash, withoutIndex }, ctx) => {
    const wt = await writeTarget(ctx, repo, worktree);
    const e = ctx.writes.journal(wt.root).redoTop();
    if (e?.id !== entry) throw stale();
    return runWrite(ctx, repo, worktree, NO_EXPECT, undoIntent({ dir: 'redo', entry: structuredClone(e), confirm: {}, autostashOk: confirmAutostash === true, withoutIndex: withoutIndex === true, outOfOrder: false, confirmDiscard: false }));
  },
  undoEntry: async ({ repo, worktree, entry, confirmAutostash }, ctx) => {
    const wt = await writeTarget(ctx, repo, worktree);
    const j = ctx.writes.journal(wt.root);
    if (j.undoTop()?.id === entry) return undoHandlers.undo({ repo, worktree, entry, confirmAutostash }, ctx);
    const found = j.outOfOrder(entry, null);
    if ('why' in found) throw dependent(found.why);
    return runWrite(ctx, repo, worktree, NO_EXPECT, undoIntent({ dir: 'undo', entry: structuredClone(found.entry), confirm: {}, autostashOk: confirmAutostash === true, withoutIndex: false, outOfOrder: true, confirmDiscard: false }));
  },
};
