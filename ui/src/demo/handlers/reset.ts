// Reset (write/reset.rs, spec #2 §9.4): the branch (or a detached HEAD) moves; mixed and hard
// snapshot every changed tracked path first, hard also the files outside the index it deletes, and
// asks first when there's anything to discard. Undo per §5.3. A folder in the way of a file holding a
// repository is refused, as the core's (the snapshot can't carry it, and git would delete it).
import type { HandlerTable } from '../transport';
import { gbError } from '../engine/errors';
import { compareBytewise } from '../engine/read/bytes';
import { readCommitOrNull } from '../engine/read/commitText';
import { fail } from '../engine/read/seam';
import { diffTrees, isTreeMode, listFiles } from '../engine/read/trees';
import { kind, repoWithin } from '../engine/write/files';
import { keepStat, loadIndex, saveIndex, stage0Of } from '../engine/write/index';
import type { JournalEntry, UndoKind } from '../engine/write/journal';
import { clearMergeState, writeOrigHead } from '../engine/write/mergeState';
import { hardReset, mixedReset, twoWayMove } from '../engine/write/move';
import { readHead, refMoved, setHead, type RefMove } from '../engine/write/refs';
import { runWrite, type WriteCx, type WriteIntent } from '../engine/write/run';
import { writeTarget, type WriteWt } from '../engine/write/seam';
import { checkRestore, checkRestoreIndex, createSnapshot, othersUnder, restoreSnapshot, restoreSnapshotIndex, type Snapshot } from '../engine/write/snapshot';
import { repositoryInTheWay } from '../engine/write/stash';
import { dirty } from '../engine/write/status';
import { heads } from './branches';

export type ResetModeT = 'soft' | 'mixed' | 'hard';
export const RESET_UNDO: Record<ResetModeT, UndoKind> = { soft: 'resetSoft', mixed: 'resetMixed', hard: 'resetHard' };
const MODE_OF: Partial<Record<UndoKind, ResetModeT>> = { resetSoft: 'soft', resetMixed: 'mixed', resetHard: 'hard' };
const short = (oid: string) => oid.slice(0, 7);

const kindAt = (wt: WriteWt, rel: string) => kind(wt, `${wt.root}/${rel}`);

export async function atRisk(wt: WriteWt, mode: ResetModeT, to: string): Promise<{ tracked: string[]; overwritten: string[] }> {
  const trackedSet = (await dirty(wt.repo, wt.root)).tracked;
  const tracked = [...trackedSet].sort(compareBytewise);
  if (mode !== 'hard') return { tracked, overwritten: [] };
  const head = readHead(wt).oid;
  if (head === null) return { tracked, overwritten: [] };
  const target = await listFiles(wt.repo, to);
  const indexed = new Set((await loadIndex(wt)).map((e) => e.path));
  const candidates = new Set([...(await diffTrees(wt.repo, head, to)).map((c) => c.path), ...tracked]);
  const out = new Set<string>();
  for (const p of candidates) {
    const e = target.get(p);
    if (!e || isTreeMode(e.mode)) continue;
    const k = kindAt(wt, p);
    if (k !== null && k !== 'dir' && !indexed.has(p)) out.add(p);
    if (k === 'dir') {
      const repo = repoWithin(wt, p);
      if (repo !== null) throw repositoryInTheWay(repo, 'reset');
      for (const f of othersUnder(wt, p, indexed)) out.add(f);
    }
    const parts = p.split('/');
    for (let i = 1; i < parts.length; i++) {
      const q = parts.slice(0, i).join('/');
      const kq = kindAt(wt, q);
      if (kq === 'dir') continue;
      if (kq !== null && !indexed.has(q)) out.add(q);
      break;
    }
  }
  return { tracked, overwritten: [...out].filter((f) => !trackedSet.has(f)).sort(compareBytewise) };
}

/** The snapshot a reset wants: P is both lists, the untracked part the overwritten files. */
const snapshotOf = (r: { tracked: string[]; overwritten: string[] }) => (r.tracked.length + r.overwritten.length === 0 ? undefined : { paths: [...r.tracked, ...r.overwritten], untracked: r.overwritten });

async function runReset(cx: WriteCx, mode: ResetModeT, to: string): Promise<void> {
  const head = readHead(cx.wt);
  if (head.branch !== null) cx.cas([{ name: heads(head.branch), old: head.oid, new: to }]);
  else setHead(cx.wt, { oid: to });
  if (head.oid !== null) writeOrigHead(cx.wt, head.oid);
  // As git's reset: a stray merge message, mode or AUTO_MERGE goes (reset refuses mid-merge).
  clearMergeState(cx.wt);
  if (mode === 'mixed') await mixedReset(cx.wt, to);
  if (mode === 'hard') await hardReset(cx.wt, to);
  cx.touch('head');
  cx.touch('index');
  if (mode === 'hard') cx.touch('worktree');
  cx.command('reset', '-q', `--${mode}`, to);
}

function reset(to: string, mode: ResetModeT, discard: boolean, x: string): WriteIntent<null> {
  return {
    kind: 'reset',
    label: () => `reset ${x} to ${short(to)} (${mode})`,
    undo: () => RESET_UNDO[mode],
    plan: async (pre) => {
      if (!/^[0-9a-fA-F]{40}$/.test(to)) fail('InvalidInput', `not an object id: ${to}`);
      if (pre.before.head.oid === null) fail('InvalidInput', `Nothing is committed on ${x} yet`);
      if ((await readCommitOrNull(pre.wt.repo, to.toLowerCase())) === null) fail('NotFound', `${short(to)}: no such commit`);
      if (mode === 'soft') return {};
      const r = await atRisk(pre.wt, mode, to.toLowerCase());
      const files = r.tracked.length + r.overwritten.length;
      if (mode === 'hard' && files > 0 && !discard) {
        const noun = files === 1 ? 'file' : 'files';
        throw { ...gbError('DirtyWorktree', `Reset ${x} to ${short(to)} and discard changes to ${files} ${noun}? You can undo this.`), detail: { kind: 'resetDiscards', branch: x, to: short(to), files } };
      }
      const snapshot = snapshotOf(r);
      return snapshot ? { snapshot } : {};
    },
    run: async (cx) => {
      cx.partial = mode !== 'soft';
      await runReset(cx, mode, to.toLowerCase());
      return null;
    },
  };
}

/** A detached HEAD moved from `from` to `to`, or the branch by the moves' CAS. */
function moveHead(cx: WriteCx, entry: JournalEntry, moves: RefMove[], from: string, to: string): void {
  if (entry.headBefore.branch !== null) {
    cx.cas(moves);
    return;
  }
  if (readHead(cx.wt).oid !== from) throw refMoved('HEAD');
  setHead(cx.wt, { oid: to });
  cx.touch('head');
}

/** `git read-tree -m -i <from> <to>`: the index alone, two-way. */
export async function twoWayIndex(wt: WriteWt, from: string, to: string): Promise<void> {
  const [a, b] = [await listFiles(wt.repo, from), await listFiles(wt.repo, to)];
  const entries = await loadIndex(wt);
  const now = stage0Of(entries);
  let next = [...entries];
  for (const c of await diffTrees(wt.repo, from, to)) {
    const cur = now.get(c.path) ?? null;
    const was = a.get(c.path) ?? null;
    const sameAs = (e: { oid: string; mode: number } | null) => (cur === null ? e === null : e !== null && cur.oid === e.oid && cur.mode === e.mode);
    if (sameAs(b.get(c.path) ?? null)) continue;
    if (!sameAs(was)) throw gbError('DirtyWorktree', `Entry '${c.path}' would be overwritten by merge. Cannot merge.`);
    next = next.filter((e) => e.path !== c.path);
    if (c.new) next.push(keepStat(now, { path: c.path, mode: c.new.mode, oid: c.new.oid, stage: 0 }));
  }
  await saveIndex(wt, next);
}

export async function stagedSince(wt: WriteWt, now: string, old: string, before: Snapshot | null): Promise<string[]> {
  const tree = await listFiles(wt.repo, now);
  const index = stage0Of(await loadIndex(wt));
  const paths = new Set((await diffTrees(wt.repo, now, old)).map((c) => c.path));
  if (before) for (const p of before.paths) if (!before.untracked.includes(p)) paths.add(p);
  return [...paths].sort(compareBytewise).filter((p) => {
    const i = index.get(p) ?? null;
    const t = tree.get(p) ?? null;
    return i === null ? t !== null : t === null || i.oid !== t.oid || i.mode !== t.mode;
  });
}

export async function undoReset(cx: WriteCx, entry: JournalEntry, moves: RefMove[], undo: boolean): Promise<void> {
  const mode = MODE_OF[entry.undo] ?? fail('Other', 'not a reset');
  const [old, next] = [entry.headBefore.oid, entry.headAfter.oid];
  if (old === null || next === null) fail('Other', "the reset's HEAD isn't recorded");
  const here = cx.before.head.branch === entry.headBefore.branch;
  if (!here && (!undo || mode !== 'soft')) fail('InvalidInput', `Check out ${entry.headBefore.branch ?? 'HEAD'} again to ${undo ? 'undo' : 'redo'} this reset`);
  const now = cx.before.head.oid ?? next;
  if (!undo) {
    if (mode !== 'soft') {
      const snap = snapshotOf(await atRisk(cx.wt, mode, next));
      const before = snap ? await createSnapshot(cx.wt, snap.paths, snap.untracked) : null;
      const e = cx.journal.entry(entry.id);
      if (e) e.before = before;
      cx.journalChanged = true;
    }
    await runReset(cx, mode, next);
    return;
  }
  if (mode === 'soft') return moveHead(cx, entry, moves, now, old);
  // The restore's checks run before anything moves (the core's check_restore); a later failure
  // still puts the index, the worktree and HEAD back, as the core does.
  if (mode === 'mixed') {
    if (entry.before) await checkRestoreIndex(cx.wt, entry.before);
    await twoWayIndex(cx.wt, now, old);
    cx.touch('index');
    try {
      if (entry.before) await restoreSnapshotIndex(cx.wt, entry.before);
      moveHead(cx, entry, moves, now, old);
    } catch (e) {
      await twoWayIndex(cx.wt, old, now).catch(() => undefined);
      throw e;
    }
    return;
  }
  if (entry.before) {
    // The files the rewind deletes don't count as a folder's contents in the way.
    const leaving = new Set((await diffTrees(cx.wt.repo, now, old)).filter((c) => c.new === null).map((c) => c.path));
    await checkRestore(cx.wt, entry.before, leaving);
  }
  await twoWayMove(cx.wt, now, old, 'readTree');
  cx.touch('worktree');
  cx.touch('index');
  let moved = false;
  try {
    moveHead(cx, entry, moves, now, old);
    moved = true;
    if (entry.before) await restoreSnapshot(cx.wt, entry.before);
  } catch (e) {
    try {
      if (moved) moveHead(cx, entry, moves.map((m) => ({ name: m.name, old: m.new, new: m.old })), old, now);
      await twoWayMove(cx.wt, old, now, 'readTree');
    } catch {
      // Put back as far as it goes; the first failure is the one reported.
    }
    throw e;
  }
}

export const resetHandlers: Pick<HandlerTable, 'reset'> = {
  reset: async ({ repo, worktree, to, mode, expect, discard }, ctx) => {
    const x = readHead(await writeTarget(ctx, repo, worktree)).branch ?? 'HEAD';
    return runWrite(ctx, repo, worktree, expect, reset(to, mode, discard === true, x));
  },
};
