// The journal's and the queue's reads (api.rs: JournalState, JournalHistory, StagingState, Queue*),
// CancelOp (a waiting write leaves the queue; a running op is told), SettlePaused, and the kept stashes'
// banners (journal/autostash.rs: ApplyKeptStash, DismissBanner).
import type { HandlerTable } from '../transport';
import { gbError } from '../engine/errors';
import { fail } from '../engine/read/seam';
import { restoreAutostash } from '../engine/write/autostash';
import { loadIndex } from '../engine/write/index';
import { inProgressName, operationKey } from '../engine/write/inProgress';
import type { KeptStash } from '../engine/write/journal';
import { journalStateOf, runWrite, type WriteIntent } from '../engine/write/run';
import { writeTarget } from '../engine/write/seam';
import { captureIndex, capturePath, OUTSIDE, RESOLVE_ENDED, restoreCapture, restorePath, samePathState, sameTree, stagingStateOf } from '../engine/write/staging';
import { applyInTheWay, dropStash, repositoryInTheWay } from '../engine/write/stash';
import { NO_EXPECT } from './stage';

type Dir = 'undo' | 'redo';

/** A kept record a banner may act on (autostash.rs `actionable`): its stash's id. */
function actionable(k: KeptStash): string {
  if (k.reason.status === 'paused') fail('InvalidInput', 'That stash waits for the merge or rebase to finish');
  if (k.reason.status === 'pending' || k.oid === null) fail('InvalidInput', "That stash's operation is still running");
  return k.oid;
}

const gone = () => gbError('Stale', 'That notice is gone; refreshed');

/** A banner's Apply (`ApplyKept`); `recovery` is always empty in the demo, so never a Restore. */
function applyKept(entry: number, label: string, withoutIndex: boolean): WriteIntent<null> {
  return {
    kind: 'stash',
    label: () => `restore changes from ${label}`,
    undo: () => null,
    plan: async (pre) => {
      // C2: a file of the stash written over a repository.
      const oid = pre.ctx.writes.journal(pre.wt.root).keptById(entry)?.oid ?? null;
      const found = oid === null ? [] : await applyInTheWay(pre.wt, oid);
      if (found.length > 0) throw repositoryInTheWay(found[0], 'apply');
      return {};
    },
    run: async (cx) => {
      const kept = cx.journal.keptById(entry);
      if (!kept) throw gone();
      const oid = actionable(kept);
      cx.journalChanged = true;
      const a = await restoreAutostash(cx, oid, kept.message, !withoutIndex);
      if (a.status === 'refused' && a.index && !withoutIndex) throw { ...gbError('Conflict', "git couldn't restore what was staged"), detail: { kind: 'applyWithoutIndex' } };
      if (a.status === 'restored') cx.journal.kept = cx.journal.kept.filter((x) => x.id !== entry);
      else kept.reason = a.status === 'conflicts' ? { status: 'conflicts', files: a.files, binary: a.binary } : { status: a.status };
      if (a.status === 'refused') fail('DirtyWorktree', a.message);
      return null;
    },
  };
}

/** A conflicts banner's Drop stash (`DropKept`). */
function dropKept(entry: number): WriteIntent<null> {
  return {
    kind: 'stash',
    label: () => 'drop the kept stash',
    undo: () => null,
    run: async (cx) => {
      const kept = cx.journal.keptById(entry);
      if (!kept) throw gone();
      const oid = actionable(kept);
      // Only after content conflicts are its changes in the worktree: a refused or partial one
      // holds the only copy of some.
      if (kept.reason.status !== 'conflicts') fail('InvalidInput', 'Apply the stash first: it holds the only copy of some of those changes');
      const n = cx.wt.demo.stashes().findIndex((s) => s.id === oid);
      cx.ctx.emit({ type: 'opStashStep', op: cx.op, step: 'restoring', message: kept.message });
      try {
        dropStash(cx.wt, oid);
      } finally {
        cx.ctx.emit({ type: 'opStashStep', op: cx.op, step: null, message: kept.message });
      }
      cx.touch('stash');
      cx.command('stash', 'drop', '-q', `stash@{${n}}`);
      cx.journal.kept = cx.journal.kept.filter((x) => x.id !== entry);
      cx.journalChanged = true;
      return null;
    },
  };
}

/** `StagingUndo` (journal/staging.rs). */
function stagingStep(dir: Dir, label: string): WriteIntent<null> {
  return {
    kind: 'stage',
    label: () => `${dir} ${label}`,
    class: 'immediate',
    undo: () => null,
    allowedInProgress: true,
    staging: 'own',
    run: async (cx) => {
      const log = cx.ctx.writes.staging(cx.wt.root);
      const step = (dir === 'undo' ? log.undo : log.redo).at(-1);
      if (!step) fail('Stale', 'Nothing to undo in staging');
      const refuse = (why: string): never => {
        log.clear();
        return fail('Stale', why);
      };
      if (step.change.kind === 'tree') {
        const want = dir === 'undo' ? step.change.after : step.change.before;
        const to = dir === 'undo' ? step.change.before : step.change.after;
        const now = await captureIndex(cx.wt);
        if (!now || !sameTree(now, want) || cx.before.head.oid !== step.head) refuse(OUTSIDE);
        await restoreCapture(cx.wt, to);
        cx.touch('index');
        cx.command('read-tree', '--reset', '<tree>');
      } else {
        const { paths, op } = step.change;
        if (cx.before.head.oid !== step.head || operationKey(cx.wt.fs, cx.wt.gitdir) !== op) refuse(RESOLVE_ENDED);
        // Every path checked before any is touched.
        for (const { path, before, after } of paths) {
          if (!samePathState(await capturePath(cx.wt, path), dir === 'undo' ? after : before)) refuse(`${path} changed since ${dir === 'undo' ? 'it was resolved' : 'its resolution was undone'}; staging history was cleared.`);
        }
        for (const { path, before, after } of paths) await restorePath(cx.wt, path, dir === 'undo' ? before : after);
        cx.touch('worktree');
        cx.touch('index');
        cx.command('update-index', '-z', '--index-info');
      }
      log.shift(dir === 'undo');
      return null;
    },
  };
}

export const journalHandlers: Pick<
  HandlerTable,
  'journalState' | 'journalHistory' | 'stagingState' | 'queueState' | 'queueRemove' | 'queueResume' | 'queueClear' | 'cancelOp' | 'stagingUndo' | 'stagingRedo' | 'settlePaused' | 'applyKeptStash' | 'dismissBanner'
> = {
  journalState: async ({ repo, worktree }, ctx) => journalStateOf(ctx, await writeTarget(ctx, repo, worktree)),
  journalHistory: async ({ repo, worktree }, ctx) => {
    const wt = await writeTarget(ctx, repo, worktree);
    const busy = inProgressName(wt.fs, wt.gitdir);
    const j = ctx.writes.journal(wt.root);
    return j.history(busy, j.state(busy).undoBlocked);
  },
  stagingState: async ({ repo, worktree }, ctx) => {
    const wt = await writeTarget(ctx, repo, worktree);
    return stagingStateOf(ctx.writes.staging(wt.root), (await loadIndex(wt)).some((e) => e.stage !== 0));
  },
  stagingUndo: async ({ repo, worktree }, ctx) => {
    const wt = await writeTarget(ctx, repo, worktree);
    const label = ctx.writes.staging(wt.root).undo.at(-1)?.label ?? fail('Stale', 'Nothing to undo in staging');
    return runWrite(ctx, repo, worktree, NO_EXPECT, stagingStep('undo', label));
  },
  stagingRedo: async ({ repo, worktree }, ctx) => {
    const wt = await writeTarget(ctx, repo, worktree);
    const label = ctx.writes.staging(wt.root).redo.at(-1)?.label ?? fail('Stale', 'Nothing to redo in staging');
    return runWrite(ctx, repo, worktree, NO_EXPECT, stagingStep('redo', label));
  },
  queueState: async ({ repo }, ctx) => (ctx.repos.get(repo), ctx.writes.queue(repo, ctx.emit).state()),
  queueRemove: async ({ repo, id }, ctx) => (ctx.repos.get(repo), ctx.writes.queue(repo, ctx.emit).remove(id)),
  queueResume: async ({ repo }, ctx) => {
    ctx.repos.get(repo);
    ctx.writes.queue(repo, ctx.emit).resume();
    return null;
  },
  queueClear: async ({ repo }, ctx) => {
    ctx.repos.get(repo);
    ctx.writes.queue(repo, ctx.emit).clear();
    return null;
  },
  cancelOp: async ({ op }, ctx) => {
    ctx.writes.cancel(op);
    return null;
  },
  // SettleIntent: runs nothing; a paused merge that ended outside GitVolt settles at step 2b.
  settlePaused: async ({ repo, worktree }, ctx) => {
    const settle: WriteIntent<null> = { kind: 'resolve', label: () => 'finish a merge or rebase', undo: () => null, allowedInProgress: true, onlySettles: true, run: async () => null };
    return runWrite(ctx, repo, worktree, NO_EXPECT, settle);
  },
  applyKeptStash: async ({ repo, worktree, entry, withoutIndex }, ctx) => {
    const wt = await writeTarget(ctx, repo, worktree);
    const k = ctx.writes.journal(wt.root).keptById(entry);
    if (!k) throw gone();
    actionable(k);
    return runWrite(ctx, repo, worktree, NO_EXPECT, applyKept(entry, k.label, withoutIndex === true));
  },
  // × keeps the stash (an explicit choice, §6.4); Drop stash drops it.
  dismissBanner: async ({ repo, worktree, entry, dropStash: drop }, ctx) => {
    if (drop) return (await runWrite(ctx, repo, worktree, NO_EXPECT, dropKept(entry))).journal;
    const wt = await writeTarget(ctx, repo, worktree);
    const j = ctx.writes.journal(wt.root);
    const k = j.keptById(entry);
    if (k) actionable(k);
    j.kept = j.kept.filter((x) => x.id !== entry);
    const state = journalStateOf(ctx, wt);
    ctx.emit({ type: 'journalChanged', repo, worktree: wt.root, state });
    return state;
  },
};
