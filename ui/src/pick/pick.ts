import { api } from '../api/client';
import type { SequenceKind } from '../api/gen/SequenceKind';
import type { SequenceOutcome } from '../api/gen/SequenceOutcome';
import { shortSha } from '../format/sha';
import type { CommitRef } from '../repo/store';
import { revealRestored } from '../stash/reveal';
import { useToast } from '../ui/toastStore';
import { runWrite, type WriteCtx } from '../write/client';

const files = (n: number) => `${n} ${n === 1 ? 'file' : 'files'}`;

/** How toasts name the commits: `a1b2c3` for one, `3 commits` for more (the journal's words). */
export const commitsWord = (commits: readonly CommitRef[]): string => (commits.length === 1 ? shortSha(commits[0].oid) : `${commits.length} commits`);

/** The toast after a cherry-pick or revert (spec #3 §3.7); `null` for a pause, where the commit
 * panel takes over with Continue / Skip / Abort and the merge tool (a commit that failed there
 * warns, naming the error). */
export function sequenceToast(o: SequenceOutcome, kind: SequenceKind, commits: readonly CommitRef[], branch: string): { message: string; warning: boolean } | null {
  const what = commitsWord(commits);
  const verb = kind === 'cherryPick' ? 'Cherry-picked' : 'Reverted';
  if (o.status === 'done') {
    if (!o.committed) return { message: `${verb} ${what} without committing: the changes are staged`, warning: false };
    return { message: kind === 'cherryPick' ? `${verb} ${what} onto ${branch}` : `${verb} ${what}`, warning: false };
  }
  const at = o.at ? ` at ${shortSha(o.at)}` : '';
  // UX R1 C.1: its commit failed (a hook, the signer): paused, its changes staged.
  if (o.committed && o.error) {
    const op = kind === 'cherryPick' ? 'cherry-pick' : 'revert';
    return { message: `The ${op} couldn't commit${at}: ${o.error.replace(/^(error|fatal): /i, '').replace(/\.+$/, '')}. Its changes are staged.`, warning: true };
  }
  if (o.committed) return null;
  const rest = commits.length > 1 ? `: ${o.applied} of ${commits.length} applied, the rest weren't` : '';
  return { message: `Stopped on conflicts in ${files(o.files)}${at}${rest}`, warning: true };
}

/** Cherry-pick or revert `commits` (newest first) on `branch`, HEAD `head` as shown (CAS). The
 * autostash's clean-restore question is `runWrite`'s. */
export async function startSequence(ctx: WriteCtx, kind: SequenceKind, commits: readonly CommitRef[], opts: { noCommit: boolean; branch: string; head: string | null }): Promise<void> {
  const oids = commits.map((c) => c.oid);
  const send = kind === 'cherryPick' ? api.cherryPick : api.revert;
  const out = await runWrite(ctx, (_, asked) => send(ctx.repoId, ctx.worktree, oids, { noCommit: opts.noCommit, confirmAutostash: asked.autostash, expect: { head: opts.head, refs: {} } }));
  if (!out) return;
  const t = sequenceToast(out, kind, commits, opts.branch);
  if (t) useToast.getState().show(t.message, t.warning ? { tone: 'warning' } : undefined);
  // UX R1 C.1: changes left uncommitted (without committing, or stopped then): their WIP row is
  // selected, no file opened (H.1). A committing pick that stopped
  // is in progress: ConflictBanner does the same, once per stop.
  if (!out.committed) await revealRestored(ctx.tabId, ctx.worktree, Promise.resolve(null), false);
}
