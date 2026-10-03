import { Cherry, Undo2 } from 'lucide-react';
import type { SequenceKind } from '../api/gen/SequenceKind';
import { shortSha } from '../format/sha';
import type { CommitTarget, MenuEnv, SelectionTarget } from '../menu/menuEnv';
import { registerMenu } from '../menu/registry';
import type { MenuRow } from '../menu/types';
import type { CommitRef } from '../repo/store';
import { startSequence } from './pick';

type Env = Pick<MenuEnv, 'write' | 'headBranch' | 'headSha' | 'inProgress'> & Partial<Pick<MenuEnv, 'isAncestor' | 'conflicted'>>;

/**
 * The Commit group's Cherry-pick and Revert for `commits` (newest first) (spec #3 §4.3). Hidden
 * (Deviation 5): any merge commit among them (§3.7); Cherry-pick when every commit is already in
 * HEAD's history; Revert when one is known not to be. Unknown ancestry shows the row. Greyed
 * during another operation, over conflicted files (a stop without committing leaves them with
 * nothing in progress), or on a detached HEAD. A selection's Cherry-pick leaves out the commits
 * already in HEAD's history.
 */
export function pickRows(commits: readonly CommitRef[], env: Env): MenuRow[] {
  const ctx = env.write;
  if (!ctx || commits.length === 0 || commits.some((c) => c.merge)) return [];
  const x = env.headBranch;
  const branch = x ?? 'HEAD';
  const busy = env.inProgress ? `Finish or abort the ${env.inProgress} first` : (env.conflicted ?? 0) > 0 ? 'Resolve conflicts first' : !x ? 'Check out a branch first' : !env.headSha ? 'Make a first commit first' : undefined;
  const inHead = (c: CommitRef) => (env.headSha ? env.isAncestor?.(c.oid, env.headSha) ?? null : null);
  const nameOf = (cs: readonly CommitRef[]) => (cs.length === 1 ? `${shortSha(cs[0].oid)} ${cs[0].summary}`.trim() : `the ${cs.length} commits`);
  const go = (kind: SequenceKind, cs: readonly CommitRef[], noCommit: boolean) => () => {
    if (x) void startSequence(ctx, kind, cs, { noCommit, branch: x, head: env.headSha });
  };
  const rows: MenuRow[] = [];
  // 3B final fix (3): what's already in HEAD's history isn't picked again.
  const picks = commits.filter((c) => inHead(c) !== true);
  if (picks.length > 0) {
    const named = nameOf(picks);
    rows.push({
      kind: 'action', id: 'commit.cherryPick', icon: Cherry,
      label: picks.length === 1 ? `Cherry-pick onto ${branch}` : `Cherry-pick ${picks.length} commits onto ${branch}`,
      tooltip: picks.length === 1 ? `Apply ${named} on top of ${branch}` : `Apply ${named} on top of ${branch}, oldest first`,
      run: go('cherryPick', picks, false), disabledReason: busy,
      variants: [{ id: 'noCommit', label: 'No commit', tooltip: `Apply the changes to ${branch}'s files and stage them, without committing`, run: go('cherryPick', picks, true), disabledReason: busy }],
    });
  }
  const one = commits.length === 1 ? commits[0] : null;
  const named = nameOf(commits);
  if (!commits.some((c) => inHead(c) === false)) {
    rows.push({
      kind: 'action', id: 'commit.revert', icon: Undo2,
      label: one ? 'Revert this commit' : `Revert ${commits.length} commits`,
      tooltip: one ? `Make a commit on ${branch} that undoes ${named}` : `Make a commit on ${branch} undoing each of ${named}, newest first`,
      run: go('revert', commits, false), disabledReason: busy,
      variants: [{ id: 'noCommit', label: 'No commit', tooltip: `Undo the changes in ${branch}'s files and stage that, without committing`, run: go('revert', commits, true), disabledReason: busy }],
    });
  }
  return rows;
}

/** A commit menu's own commit, as the loaded graph knows it (not loaded: summary unknown, not a
 * merge as far as the menu can tell; the backend refuses a merge). */
const commitOf = (t: CommitTarget, env: MenuEnv): CommitRef => {
  const info = env.commitInfo?.(t.sha) ?? null;
  return { oid: t.sha, summary: info?.summary ?? '', merge: info?.merge ?? false };
};

export const offPickMenus = [
  registerMenu<CommitTarget, MenuEnv>({
    id: 'commit.pick', kind: 'commit', group: 'commit', order: 0,
    when: (t, env) => !t.isWip && !t.isStash && !!env.write,
    rows: (t, env) => pickRows([commitOf(t, env)], env),
  }),
  registerMenu<SelectionTarget, MenuEnv>({
    id: 'selection.pick', kind: 'selection', group: 'commit', order: 0,
    when: (_, env) => !!env.write,
    rows: (t, env) => pickRows(t.commits, env),
  }),
];
