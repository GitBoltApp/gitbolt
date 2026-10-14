// cherryPick, revert and pickControl (the core's write/sequence.rs and write/pick.rs).
import type { Confirm } from '../../api/gen/Confirm';
import type { Expect } from '../../api/gen/Expect';
import type { PickOutcome } from '../../api/gen/PickOutcome';
import type { RebaseAction } from '../../api/gen/RebaseAction';
import { asGbError, gitFailure } from '../engine/errors';
import { demoOf, fail } from '../engine/read/seam';
import { abortSeq, continueSeq, skipSeq } from '../engine/seq/engine';
import { sequenceIntent, type SeqWhich } from '../engine/seq/pick';
import { readSeq } from '../engine/seq/state';
import { conflicted, NO_EXPECT, runWrite, worktreeNow, type WriteIntent } from '../engine/writeSeam';
import type { HandlerTable } from '../transport';

type Ctx = Parameters<HandlerTable['cherryPick']>[1];

/** `git <what> --continue|--skip|--abort` as the core's `PickControl` runs it (it isn't journaled,
 *  like the rebase's controls). */
function pickControlIntent(what: 'cherry-pick' | 'revert', action: RebaseAction, message: string | undefined): WriteIntent<PickOutcome> {
  const step = action === 'continue' ? 'continue' : action === 'skip' ? 'skip a commit of' : 'abort';
  return {
    kind: 'commit',
    label: () => `${step} the ${what}`,
    undo: null,
    allowedInProgress: true,
    async run(cx) {
      if (cx.before.inProgress !== what) fail('InvalidInput', `No ${what} is in progress`);
      if (action === 'abort') {
        await abortSeq(cx, 'pick');
        return { status: 'aborted' };
      }
      if (action === 'continue') {
        const n = conflicted(demoOf(cx.read).fs, cx.gitdir);
        if (n > 0) fail('InvalidInput', `Resolve ${n} conflicted ${n === 1 ? 'file' : 'files'} first`);
      }
      // The box's message goes only when typed (it replaces the commit message file's).
      const typed = action === 'continue' && message !== undefined && message.trim() !== '' ? message : undefined;
      let end;
      try {
        end = action === 'continue' ? await continueSeq(cx, typed, 'pick') : await skipSeq(cx, 'pick');
      } catch (e) {
        // A Continue or Skip that failed on the next commit with nothing in progress: the sequence is
        // dropped, the commits stay, and the error says so.
        const err = asGbError(e);
        const applied = / \(\d+ of \d+ applied, the rest weren't\)$/;
        if ((await readSeq(cx.read, cx.gitdir)) === null && applied.test(err.message)) throw { ...err, message: `${err.message.replace(applied, '')} (the rest of the ${what} wasn't applied)` };
        throw e;
      }
      if (end.status === 'done') return { status: 'done' };
      // Still in progress with no conflicts: the commit itself failed (an empty pick), git's error goes up.
      if (end.files === 0) throw gitFailure(end.stop.error ?? 'git exited with status 1', '');
      return { status: 'stopped', files: end.files };
    },
  };
}

/** For the queue's label only: HEAD's branch settles in `plan`, under the lock. */
async function seenBranch(ctx: Ctx, repo: number, worktree: string): Promise<string | undefined> {
  try {
    return (await worktreeNow(ctx, repo, worktree)).branch ?? undefined;
  } catch {
    return undefined; // runWrite refuses an unknown worktree itself.
  }
}

type Start = { repo: number; worktree: string; oids: string[]; noCommit?: boolean; expect: Expect; confirm: Confirm };
const start = async (kind: SeqWhich, { repo, worktree, oids, noCommit, expect, confirm }: Start, ctx: Ctx) =>
  runWrite(ctx, repo, worktree, expect, sequenceIntent({ kind, oids, noCommit: noCommit ?? false, confirm, seen: await seenBranch(ctx, repo, worktree) }));

export const pickHandlers: Pick<HandlerTable, 'cherryPick' | 'revert' | 'pickControl'> = {
  cherryPick: (p, ctx) => start('cherryPick', p, ctx),
  revert: (p, ctx) => start('revert', p, ctx),
  pickControl: async ({ repo, worktree, action, message }, ctx) => {
    const name = (await worktreeNow(ctx, repo, worktree)).inProgress;
    if (name !== 'cherry-pick' && name !== 'revert') fail('InvalidInput', 'No cherry-pick or revert is in progress');
    return runWrite(ctx, repo, worktree, NO_EXPECT, pickControlIntent(name, action, message));
  },
};
