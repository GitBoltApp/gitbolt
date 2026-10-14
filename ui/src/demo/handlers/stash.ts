// Stashes (write/stash.rs, spec #2 §10): identity is the stash commit's id, never a list position.
// Push and pop and drop are journaled (UndoKind::Stash); apply isn't (the stash is kept).
import type { GbError } from '../../api/gen/GbError';
import type { StashApplyOutcome } from '../../api/gen/StashApplyOutcome';
import type { StashPushOutcome } from '../../api/gen/StashPushOutcome';
import type { HandlerTable } from '../transport';
import { gbError } from '../engine/errors';
import { readCommit } from '../engine/read/commitText';
import { fail } from '../engine/read/seam';
import type { JournalEntry } from '../engine/write/journal';
import { readHead } from '../engine/write/refs';
import { runWrite, type WriteCx, type WriteIntent } from '../engine/write/run';
import { writeTarget } from '../engine/write/seam';
import { createSnapshot, restoreSnapshot, untrackedAmong } from '../engine/write/snapshot';
import { applyInTheWay, applyStash, dropStash, pushInTheWay, pushStash, repositoryInTheWay, stashList, stashPaths, storeStash, subjectOf, userMessage, type StashApplied } from '../engine/write/stash';
import { dirty } from '../engine/write/status';
import { NO_EXPECT } from './stage';

export function applyError(r: StashApplied): GbError | null {
  switch (r.kind) {
    case 'applied':
    case 'conflicts':
      return null;
    case 'indexRefused':
      return { ...gbError('Conflict', "git couldn't restore what was staged"), detail: { kind: 'applyWithoutIndex' } };
    default:
      return r.error;
  }
}

export function forgetKept(cx: WriteCx, oid: string): void {
  if (cx.journal.forgetKeptStash(oid)) cx.journalChanged = true;
}


const firstLine = (m: string) => (m.split('\n')[0] ?? '').trim();

/** Why a pop whose `after` snapshot failed can't be undone (stash.rs's NO_AFTER). */
const NO_AFTER = "Can't be undone: GitVolt couldn't record what the pop left";

/** The core's `relist` lists a multi-line message again by its first line (a drop, then a store),
 *  guarded by a pending kept-stash record that goes once the stash is listed again. The demo's
 *  store is atomic, so the guard shows only as the journal id it takes, as the core's does. */
function relistGuard(cx: WriteCx, oid: string, subject: string, message: string, label: string): void {
  if (!message.trimEnd().includes('\n')) return;
  // The core's early return: a stored line that already reads as the summary needs no relist.
  // The demo keeps the summary as the subject, so git's folded line is rebuilt from the message.
  const prefix = subject.slice(0, subject.length - userMessage(subject).length);
  const folded = `${prefix}${message.trim().split('\n').map((l) => l.trim()).filter(Boolean).join(' ')}`;
  if (folded === `${prefix}${firstLine(message)}`) return;
  const id = cx.journal.keep({ oid, message: firstLine(message), label, target: null, reason: { status: 'pending' }, createdMs: cx.ctx.clock.nowMs() });
  cx.journal.kept = cx.journal.kept.filter((k) => k.id !== id);
  cx.journalChanged = true;
}

/** The safety review's C1 and C2: the first repository a stash's write would delete refuses it. */
function refuseInTheWay(found: string[], what: string): void {
  if (found.length > 0) throw repositoryInTheWay(found[0], what);
}

function push(message: string): WriteIntent<StashPushOutcome> {
  return {
    kind: 'stash',
    label: () => `stash "${firstLine(message)}"`,
    undo: () => 'stash',
    plan: async (pre) => {
      refuseInTheWay(await pushInTheWay(pre.wt, (await dirty(pre.wt.repo, pre.wt.root)).tracked, null), 'stash');
      return {};
    },
    run: async (cx) => {
      const s = await pushStash(cx.wt, cx.ident(), message, { untracked: 'untracked', paths: null });
      cx.command('stash', 'push', '--include-untracked', '-m', message);
      if (s === null) return { status: 'nothingToStash' };
      for (const k of ['stash', 'worktree', 'index'] as const) cx.touch(k);
      cx.recordStash({ oid: s.oid, message: s.subject, created: true, withoutIndex: false });
      relistGuard(cx, s.oid, s.subject, message, `stash "${firstLine(message)}"`);
      return { status: 'stashed', oid: s.oid };
    },
  };
}

function apply(oid: string, pop: boolean, withoutIndex: boolean, subject: string): WriteIntent<StashApplyOutcome> {
  const label = `${pop ? 'pop' : 'apply'} stash "${userMessage(subject)}"`;
  return {
    kind: 'stash',
    label: () => label,
    undo: () => (pop ? 'stash' : null),
    plan: async (pre) => {
      subjectOf(pre.wt, oid);
      refuseInTheWay(await applyInTheWay(pre.wt, oid), pop ? 'pop' : 'apply');
      if (!pop) return {};
      const paths = await stashPaths(pre.wt, oid);
      return { snapshot: { paths, untracked: await untrackedAmong(pre.wt, paths) } };
    },
    run: async (cx) => {
      cx.command('stash', 'apply', ...(withoutIndex ? [] : ['--index']), oid);
      cx.touch('worktree');
      cx.touch('index');
      const r = await applyStash(cx.wt, oid, !withoutIndex);
      const error = applyError(r);
      if (r.kind !== 'indexRefused') cx.partial = true;
      if (error) throw error;
      if (r.kind === 'conflicts') return { status: 'conflicts', files: r.paths.length };
      if (pop) {
        cx.recordStash({ oid, message: subject, created: false, withoutIndex });
        dropStash(cx.wt, oid);
        forgetKept(cx, oid);
        // The pop is done: a failed `after` only costs its undo.
        try {
          cx.after = await createSnapshot(cx.wt, cx.snapshot?.paths ?? [], []);
        } catch {
          cx.editEntry((e) => {
            e.blocked = NO_AFTER;
          });
        }
      }
      return { status: 'applied' };
    },
  };
}

function drop(oid: string, subject: string): WriteIntent<null> {
  return {
    kind: 'stash',
    label: () => `drop stash "${userMessage(subject)}"`,
    undo: () => 'stash',
    run: async (cx) => {
      // Nothing changes when the stash is gone (NotFound), so no entry: the core unrecords it too.
      dropStash(cx.wt, oid);
      cx.recordStash({ oid, message: subject, created: false, withoutIndex: false });
      forgetKept(cx, oid);
      cx.command('stash', 'drop');
      return null;
    },
  };
}

/** Edits the entry an undo or redo acts on (the undo itself has no entry). */
function edit(cx: WriteCx, id: number, f: (e: JournalEntry) => void): void {
  const e = cx.journal.entry(id);
  if (e) f(e);
  cx.journalChanged = true;
}

const conflictKept = () => gbError('Conflict', "The stash's changes conflict; it was kept");

export async function undoStash(cx: WriteCx, entry: JournalEntry, undo: boolean, label: string, withoutIndex: boolean): Promise<void> {
  const wt = cx.wt;
  const moved = entry.stashes[0] ?? null;
  if (moved?.created) {
    if (undo) {
      subjectOf(wt, moved.oid);
      cx.touch('worktree');
      cx.touch('index');
      const r = await applyStash(wt, moved.oid, !withoutIndex);
      const error = applyError(r);
      if (error) throw error;
      if (r.kind === 'conflicts') throw conflictKept();
      dropStash(wt, moved.oid);
      cx.touch('stash');
      return;
    }
    const full = (await readCommit(wt.repo, moved.oid)).rawMessage.trimEnd();
    const message = userMessage(full);
    const s = await pushStash(wt, cx.ident(), message, { untracked: 'untracked', paths: null });
    if (s === null) fail('InvalidInput', 'Nothing to stash');
    cx.touch('stash');
    cx.touch('worktree');
    cx.touch('index');
    edit(cx, entry.id, (e) => {
      e.stashes[0] = { oid: s.oid, message: s.subject, created: true, withoutIndex: false };
    });
    relistGuard(cx, s.oid, s.subject, message, label);
    return;
  }
  if (entry.before !== null) {
    cx.touch('worktree');
    cx.touch('index');
    if (undo) {
      if (moved && !stashList(wt).some((s) => s.oid === moved.oid)) {
        storeStash(wt, cx.ident(), moved.oid, moved.message);
        cx.touch('stash');
      }
      await restoreSnapshot(wt, entry.before);
      return;
    }
    if (!moved) fail('InvalidInput', 'That pop kept its stash; nothing to redo');
    const without = withoutIndex || moved.withoutIndex;
    subjectOf(wt, moved.oid);
    const paths = await stashPaths(wt, moved.oid);
    const snap = await createSnapshot(wt, paths, await untrackedAmong(wt, paths));
    const r = await applyStash(wt, moved.oid, !without);
    const error = applyError(r);
    if (error) throw error;
    if (r.kind === 'conflicts') {
      edit(cx, entry.id, (e) => {
        e.before = snap;
      });
      throw conflictKept();
    }
    dropStash(wt, moved.oid);
    cx.touch('stash');
    const after = await createSnapshot(wt, snap.paths, []).catch(() => null);
    edit(cx, entry.id, (e) => {
      e.before = snap;
      e.after = after;
      e.blocked = after === null ? NO_AFTER : null;
      if (e.stashes[0]) e.stashes[0].withoutIndex = without;
    });
    return;
  }
  if (moved) {
    if (undo) storeStash(wt, cx.ident(), moved.oid, moved.message);
    else dropStash(wt, moved.oid);
    cx.touch('stash');
  }
}

export const stashHandlers: Pick<HandlerTable, 'stashPush' | 'stashApply' | 'stashDrop'> = {
  stashPush: async ({ repo, worktree, message }, ctx) => {
    const branch = readHead(await writeTarget(ctx, repo, worktree)).branch;
    const m = message.trim() === '' ? `WIP on ${branch ?? '(no branch)'}` : message;
    return runWrite(ctx, repo, worktree, NO_EXPECT, push(m));
  },
  stashApply: async ({ repo, worktree, oid, pop, withoutIndex }, ctx) => {
    const subject = subjectOf(await writeTarget(ctx, repo, worktree), oid);
    return runWrite(ctx, repo, worktree, NO_EXPECT, apply(oid, pop, withoutIndex === true, subject));
  },
  stashDrop: async ({ repo, worktree, oid }, ctx) => {
    const subject = subjectOf(await writeTarget(ctx, repo, worktree), oid);
    return runWrite(ctx, repo, worktree, NO_EXPECT, drop(oid, subject));
  },
};
