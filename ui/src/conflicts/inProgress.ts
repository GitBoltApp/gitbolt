import type { GraphPayload } from '../api/gen/GraphPayload';
import type { InProgress } from '../api/gen/InProgress';
import type { PausedInfo } from '../api/gen/PausedInfo';
import { useOps } from '../app/ops';
import { branchOf, mergedName } from './sides';

/** The worktree's merge, rebase or other operation (spec #2 §13.2; plan 2D Deviation 1). */
export const inProgressOf = (graph: Pick<GraphPayload, 'inProgress'>, worktree: string): InProgress | null => graph.inProgress?.[worktree] ?? null;

/** A merge, rebase or pull of this repo is running: its state is transient, the commit panel's
 * controls wait (Review Focus 1). */
export const useIntegrating = (repoId: number): boolean =>
  useOps((s) => Object.values(s.ops).some((o) => o.repo === repoId && (o.kind === 'merge' || o.kind === 'rebase' || o.kind === 'pull')));

const short = (oid: string) => oid.slice(0, 7);
const files = (n: number) => `${n} conflicted ${n === 1 ? 'file' : 'files'}`;
/** At a conflict stop git's message file ends with a `# Conflicts:` block; the box drops that
 * block only. Other `#` lines (`#123`, a Markdown heading) are the message's own and stay. */
export function withoutComments(message: string): string {
  const lines = message.replace(/\r\n?/g, '\n').split('\n');
  const at = lines.findIndex((l, i) => l === '# Conflicts:' && lines.slice(i + 1).every((x) => x.startsWith('#') || !x.trim()));
  return at < 0 ? lines.join('\n') : lines.slice(0, at).join('\n').replace(/\n+$/, '\n');
}

/**
 * What the commit panel shows for an operation in progress (§13.2, ux round 1): the status block
 * at the top of the commit box, and what its buttons say.
 */
export interface OperationView {
  kind: InProgress['kind'];
  /** A rebase's stopped commit: its message prefills the box when git wrote none. */
  stoppedAt: string | null;
  /** At an interactive rebase's Edit stop (spec #3 §3.5): the commit git made there; `null` otherwise. */
  editStop: string | null;
  /** 3C T13 fix 1 (A1): an Edit stop of a rebase started outside GitBolt (in a terminal): the core
   * refuses Commit and Split there, so they hide. */
  editElsewhere?: boolean;
  /** The status block's accessible name. */
  region: string;
  /** "Rebasing feature/x onto main (step 1 of 2)". */
  title: string;
  /** "Stopped at a1b2c3d Fix x". */
  detail: string | null;
  /** What to do next: resolve the conflicts first, or go on (a paused one says so). */
  hint: string;
  conflicted: number;
  /** The primary button; `null`: GitBolt has no control for it (finish it in a terminal). */
  primary: string | null;
  skip: boolean;
  /** Identifies one stop: the box's message is prefilled once per stop. */
  stop: string;
  /** The prefilled message (rebase, cherry-pick, revert; `#` lines dropped). A merge uses the
   * WIP draft instead (§8.2), so it's empty there. */
  message: string;
}

/** "Resolve 2 conflicted files first" (§8.1's reason, here too). */
export const resolveFirst = (n: number) => `Resolve ${files(n)} first`;

export function operationView(p: InProgress, paused: PausedInfo | null, branch: string | null, subjectOf: (sha: string) => string | null, nameAt: (sha: string) => string | null = () => null): OperationView {
  const at = (sha: string | null, verb: string) => {
    if (!sha) return null;
    const subject = subjectOf(sha);
    return `${verb} ${short(sha)}${subject ? ` ${subject}` : ''}`;
  };
  switch (p.kind) {
    case 'merge': {
      const y = paused?.target ?? mergedName(p.message) ?? short(p.mergeHead);
      return {
        kind: 'merge',
        stoppedAt: null,
        editStop: null,
        region: 'Merge in progress',
        title: `Merging ${y} into ${branch ? branchOf(branch) : 'HEAD'}`,
        detail: null,
        hint: p.conflicted ? resolveFirst(p.conflicted) : 'No conflicted files left: commit to finish the merge.',
        conflicted: p.conflicted,
        primary: 'Commit and merge',
        skip: false,
        stop: `merge:${p.mergeHead}`,
        message: '',
      };
    }
    case 'rebase': {
      // A rebase git started has only the onto oid: a branch there names it, as the user typed it.
      const onto = paused?.target ?? nameAt(p.onto) ?? short(p.onto);
      // --- 3C T13: an Edit stop (its message is HEAD's: the commit's subject) ---
      const edit = p.editStop && p.conflicted === 0 ? p.editStop : null;
      // `gitbolt`: GitBolt started this rebase (its interactive rebase), not a terminal.
      const elsewhere = !!edit && !p.gitbolt;
      // --- end 3C T13 ---
      // 3C final fixes: a new message a hook refused (M1, M2); an Edit row whose pick conflicted
      // (I1: git won't stop for it again, so this stop is the Edit's).
      const failed = p.messageFailed ? `The new message wasn't applied: ${p.messageFailed.replace(/\.+$/, '')}. Type it again to retry, or Continue to keep the old one.` : null;
      const stillPaused = p.editConflict ? 'This commit was set to Edit: make any other changes now, then Continue.' : 'No conflicted files left: it is paused. Continue to go on.';
      return {
        kind: 'rebase',
        stoppedAt: p.stoppedAt,
        editStop: edit,
        editElsewhere: elsewhere,
        region: 'Rebase in progress',
        title: `Rebasing ${branchOf(p.headName)} onto ${onto} (step ${p.step} of ${p.total})`,
        detail: edit ? `Stopped to edit ${short(edit)} ${p.message.split('\n')[0]}`.trimEnd() : at(p.stoppedAt, 'Stopped at'),
        // No conflicted file left: still paused (a cancelled Continue, a killed run, a failing hook).
        hint: elsewhere ? 'Finish this rebase where you started it.' : failed ?? (edit ? 'Amend it, or split it into smaller commits, then Continue.' : p.conflicted ? resolveFirst(p.conflicted) : stillPaused),
        conflicted: p.conflicted,
        primary: 'Continue rebase',
        skip: !edit,
        stop: `rebase:${edit ?? p.stoppedAt ?? ''}:${p.step}`,
        message: withoutComments(p.message),
      };
    }
    case 'cherryPick':
    case 'revert': {
      const pick = p.kind === 'cherryPick';
      const name = pick ? 'cherry-pick' : 'revert';
      return {
        kind: p.kind,
        stoppedAt: null,
        editStop: null,
        region: pick ? 'Cherry-pick in progress' : 'Revert in progress',
        title: at(p.head, pick ? 'Cherry-picking' : 'Reverting') ?? `A ${name} is in progress`,
        detail: null,
        hint: p.conflicted ? resolveFirst(p.conflicted) : `No conflicted files left: Continue to commit the ${name}.`,
        conflicted: p.conflicted,
        primary: `Continue ${name}`,
        skip: true,
        stop: `${name}:${p.head ?? ''}`,
        message: withoutComments(p.message),
      };
    }
    default:
      return { kind: 'other', stoppedAt: null, editStop: null, region: 'Operation in progress', title: `${/^[aeiou]/.test(p.what) ? 'An' : 'A'} ${p.what} is in progress`, detail: null, hint: 'Finish it in a terminal.', conflicted: 0, primary: null, skip: false, stop: p.what, message: '' };
  }
}
