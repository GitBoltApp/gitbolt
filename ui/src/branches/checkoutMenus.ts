import { GitBranch, GitCommitVertical, RotateCcw } from 'lucide-react';
import type { RefLabel } from '../api/gen/RefLabel';
import { registerGraphDoubleClick } from '../graph/rowActions';
import type { CommitTarget, MenuEnv } from '../menu/menuEnv';
import { registerMenu } from '../menu/registry';
import type { MenuRow } from '../menu/types';
import { registerSidebarDoubleClick } from '../sidebar/itemActions';
import { checkout, checkoutLabel, checkoutSideItem } from './checkout';
import { resetTo } from './reset';

const busy = (env: MenuEnv) => (env.inProgress ? `Finish or abort the ${env.inProgress} first` : undefined);

/** Checkout ▸ (spec #2 §9.3): the branches at that commit, then `Detached HEAD at a1b2c3`. */
function checkoutRows(t: CommitTarget, env: MenuEnv): MenuRow[] {
  const ctx = env.write!;
  const expect = (ref: string) => ({ head: env.headSha, refs: { [ref]: t.sha } });
  const branchRow = (l: RefLabel): MenuRow[] => {
    if (l.tag || (!l.local && l.remotes.length === 0)) return [];
    if (l.local) {
      // The checked-out branch has nothing to check out: not offered.
      if (l.isHead) return [];
      const full = l.local;
      const name = full.replace(/^refs\/heads\//, '');
      return [{ kind: 'action', id: `checkout:${full}`, label: name, icon: GitBranch, tooltip: `Check out ${name}`, run: () => { void checkout(ctx, { kind: 'branch', name }, expect(full)); }, disabledReason: busy(env) }];
    }
    const r = l.remotes.find((x) => x.remote === 'origin') ?? l.remotes[0];
    const branch = r.fullName.slice(`refs/remotes/${r.remote}/`.length);
    return [{ kind: 'action', id: `checkout:${r.fullName}`, label: `${r.remote}/${branch}`, icon: GitBranch, tooltip: `Check out ${branch}, tracking ${r.remote}/${branch}`, run: () => { void checkout(ctx, { kind: 'remote', remote: r.remote, branch }, expect(r.fullName)); }, disabledReason: busy(env) }];
  };
  const branches = env.labelsAt(t.sha).flatMap(branchRow);
  const detached: MenuRow = { kind: 'action', id: 'checkout:detached', label: `Detached HEAD at ${t.sha.slice(0, 7)}`, icon: GitCommitVertical, tooltip: 'Check out this commit without a branch', run: () => { void checkout(ctx, { kind: 'detached', oid: t.sha }, { head: env.headSha, refs: {} }); }, disabledReason: busy(env) };
  return [...branches, ...(branches.length ? [{ kind: 'separator' as const }] : []), detached];
}

export const offCheckoutMenus = [
  registerMenu<CommitTarget, MenuEnv>({
    id: 'branch.checkout', kind: 'commit', group: 'branch', order: 0,
    when: (t, env) => !t.isWip && !t.isStash && !!env.write,
    rows: (t, env) => [{ kind: 'submenu', id: 'branch.checkout', label: 'Checkout', icon: GitBranch, tooltip: 'Check out a branch at this commit, or the commit itself', rows: checkoutRows(t, env) }],
  }),
  // Reset sits early: the top group, right after the sync rows.
  registerMenu<CommitTarget, MenuEnv>({
    id: 'commit.reset', kind: 'commit', group: 'sync', order: 90,
    when: (t, env) => !t.isWip && !t.isStash && !!env.write && t.sha !== env.headSha,
    rows: (t, env) => {
      const x = env.headBranch ?? 'HEAD';
      const run = (mode: 'soft' | 'mixed' | 'hard') => () => { void resetTo(env.write!, t.sha, mode, env.headSha); };
      const why = busy(env);
      return [{
        kind: 'action', id: 'commit.reset', label: `Reset ${x} to this commit`, icon: RotateCcw,
        tooltip: `Move ${x} to ${t.sha.slice(0, 7)}, keeping the working copy but resetting the index`,
        run: run('mixed'), disabledReason: why,
        variants: [
          { id: 'soft', label: 'Soft', tooltip: 'keep all changes', run: run('soft'), disabledReason: why },
          { id: 'mixed', label: 'Mixed', tooltip: 'keep working copy but reset index', run: run('mixed'), disabledReason: why },
          { id: 'hard', label: 'Hard', tooltip: 'discard all changes', run: run('hard'), disabledReason: why },
        ],
      }];
    },
  }),
  registerGraphDoubleClick({ label: checkoutLabel }),
  registerSidebarDoubleClick('local', checkoutSideItem),
  registerSidebarDoubleClick('remote', checkoutSideItem),
];
import.meta.hot?.dispose(() => { for (const off of offCheckoutMenus) off(); });
