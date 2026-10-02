import type { GraphPayload } from '../api/gen/GraphPayload';
import type { InProgress } from '../api/gen/InProgress';
import type { PausedInfo } from '../api/gen/PausedInfo';
import { useOps } from '../app/ops';

/** The worktree's merge, rebase or other operation (spec #2 §13.2; plan 2D Deviation 1). */
export const inProgressOf = (graph: Pick<GraphPayload, 'inProgress'>, worktree: string): InProgress | null => graph.inProgress?.[worktree] ?? null;

/** A merge, rebase or pull of this repo is running: its state is transient, the banner waits
 * (Review Focus 1). */
export const useIntegrating = (repoId: number): boolean =>
  useOps((s) => Object.values(s.ops).some((o) => o.repo === repoId && (o.kind === 'merge' || o.kind === 'rebase' || o.kind === 'pull')));

const short = (oid: string) => oid.slice(0, 7);
const files = (n: number) => `${n} conflicted ${n === 1 ? 'file' : 'files'}`;
const branchOf = (headName: string) => headName.replace(/^refs\/heads\//, '');
const mergedName = (message: string) => /^Merge (?:remote-tracking )?branch '([^']+)'/.exec(message)?.[1] ?? null;

/** The banner's sentence: it says the state the repo is in. With no conflicted file left the
 * operation is still paused (a cancelled Continue, a killed run or a failing hook), and says so. */
export function bannerText(p: InProgress, paused: PausedInfo | null, branch: string | null, subjectOf: (sha: string) => string | null, nameAt: (sha: string) => string | null = () => null): string {
  switch (p.kind) {
    case 'merge': {
      const y = paused?.target ?? mergedName(p.message) ?? short(p.mergeHead);
      const tail = p.conflicted ? `${files(p.conflicted)}.` : 'no conflicted files left; commit the merge to finish it.';
      return `Merging ${y} into ${branch ? branchOf(branch) : 'HEAD'}: ${tail}`;
    }
    case 'rebase': {
      // A rebase git started has only the onto oid: a branch there names it, as the user typed it.
      const onto = paused?.target ?? nameAt(p.onto) ?? short(p.onto);
      const subject = p.stoppedAt ? subjectOf(p.stoppedAt) : null;
      const at = p.stoppedAt ? `, stopped at ${short(p.stoppedAt)}${subject ? ` ${subject}` : ''}` : '';
      const tail = p.conflicted ? '.' : '; no conflicted files left, so it is paused: Continue to go on.';
      return `Rebasing ${branchOf(p.headName)} onto ${onto}: step ${p.step} of ${p.total}${at}${tail}`;
    }
    default:
      return `A ${p.what} is in progress; finish it in a terminal.`;
  }
}
