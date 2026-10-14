// Rebase handlers (plan 4): the interactive rebase's plan (the core's irebase/plan.rs), and the
// commit panel's Continue, Skip and Abort of a rebase (the core's write/rebase.rs `RebaseControl`),
// the interactive rebase and the reword of an older commit (irebase/run.rs, reword.rs).
import type { IntegrateOutcome } from '../../api/gen/IntegrateOutcome';
import type { RebaseAction } from '../../api/gen/RebaseAction';
import { relation } from '../engine/read/revs';
import { worktreeRoot } from '../engine/read/worktrees';
import { predict } from '../engine/seq/predict';
import { rebasePlan } from '../engine/seq/plan';
import { abortSeq, continueSeq, skipSeq, type SeqEnd } from '../engine/seq/engine';
import { readSeq, type SeqState } from '../engine/seq/state';
import { irebaseIntent, rewordCommit } from '../engine/seq/irebase';
import { shortRef } from '../engine/seq/range';
import { stoppedOutcome } from '../engine/seq/rebase';
import { fail, readRepoOf } from '../engine/read/seam';
import { NO_EXPECT, runWrite, type WriteCx, type WriteIntent } from '../engine/writeSeam';
import type { HandlerTable } from '../transport';

/** What a Continue or Skip answers: still stopped (the paused entry stays: `cx.paused` says so), or
 *  done. A step git refused shows as the core's warning, as the rebase's start does. */
async function outcome(cx: WriteCx, s: SeqState, end: SeqEnd): Promise<IntegrateOutcome> {
  const onto = s.onto;
  if (end.status === 'stopped') {
    // GitVolt's interactive rebase keeps its session on the paused entry (what was made, what moved).
    cx.paused = { kind: 'rebase', target: s.target, targetOid: onto, picked: [], irebase: s.interactive };
    return stoppedOutcome(end);
  }
  const [commits] = await relation(cx.read, end.head, onto);
  return { status: 'done', commits, fastForward: false, ...(end.warning ? { warning: end.warning } : {}) };
}

/** Not a `rewrite` intent: a completed rebase is recorded by settle (the core's RebaseControl has no rewrite()). */
export function rebaseControlIntent(action: RebaseAction, message: string | undefined): WriteIntent<IntegrateOutcome> {
  const step = action === 'continue' ? 'continue' : action === 'skip' ? 'skip a commit of' : 'abort';
  return {
    kind: 'rebase',
    label: () => `${step} the rebase`,
    undo: null,
    allowedInProgress: true,
    async run(cx) {
      const s = await readSeq(cx.read, cx.gitdir);
      if (cx.before.inProgress !== 'rebase' || !s) fail('InvalidInput', 'No rebase is in progress');
      if (action === 'abort') {
        const a = await abortSeq(cx, 'rebase');
        return { status: 'aborted', ...(a.stash ? { stash: a.stash } : {}), ...(a.branch ? { branch: a.branch } : {}) };
      }
      // The box's message goes only when typed (the core's `typed`).
      const typed = action === 'continue' && message !== undefined && message.trim() !== '' ? message : undefined;
      const end = action === 'continue' ? await continueSeq(cx, typed, 'rebase') : await skipSeq(cx, 'rebase');
      return outcome(cx, s, end);
    },
  };
}

export const rebaseHandlers: Pick<HandlerTable, 'rebasePlan' | 'predictRebase' | 'rebaseControl' | 'interactiveRebase' | 'rewordCommit'> = {
  rebasePlan: async ({ repo, worktree, branch, base }, ctx) => {
    const read = readRepoOf(ctx, repo);
    return rebasePlan(read, await worktreeRoot(read, worktree), branch, base);
  },
  predictRebase: async ({ repo, worktree, base, rows }, ctx) => {
    const read = readRepoOf(ctx, repo);
    const root = await worktreeRoot(read, worktree);
    return predict(read, `${repo}:${root}`, root, base, rows);
  },
  rebaseControl: ({ repo, worktree, action, message }, ctx) => runWrite(ctx, repo, worktree, NO_EXPECT, rebaseControlIntent(action, message)),
  // The core's `interactive_rebase`: the plan's expected refs checked (none may be missing).
  interactiveRebase: ({ repo, worktree, branch, base, expect, rows, chips, confirm }, ctx) =>
    runWrite(ctx, repo, worktree, { head: null, refs: expect }, irebaseIntent({ branch, base, source: { kind: 'plan', rows, chips }, confirm, label: `interactive rebase ${branch} onto ${shortRef(base)}` })),
  rewordCommit: (p, ctx) => rewordCommit(ctx, p),
};
