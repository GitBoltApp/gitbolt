import { describe, expect, it } from 'vitest';
import type { CommitTarget, MenuEnv } from '../menu/menuEnv';
import { buildMenu } from '../menu/registry';
import './checkoutMenus';

const label = (name: string, local: boolean, isHead = false) => ({ row: 0, name, local: local ? `refs/heads/${name}` : null, remotes: local ? [] : [{ fullName: `refs/remotes/origin/${name}`, remote: 'origin', host: null, hostKind: 'generic' }], tag: false, isHead, worktree: null, checkedOut: null });
const env = (over: object = {}) => ({ write: { tabId: 't', repoId: 1, worktree: '/r' }, headBranch: 'main', headSha: 'zzz', inProgress: null, activeWorktree: '/r', labelsAt: () => [label('main', true, true), label('feature/x', true), label('only-remote', false)], ...over }) as unknown as MenuEnv;
const t: CommitTarget = { sha: 'aaaaaaa1', mrRefs: [], isWip: false, isStash: false, branch: null };

describe('Checkout ▸ and Reset (spec #2 §9.3, §9.4)', () => {
  it('Checkout ▸ lists the branches at the commit, then the detached HEAD', () => {
    const sub = buildMenu('commit', t, env()).find((r) => r.kind === 'submenu' && r.id === 'branch.checkout');
    expect(sub?.kind === 'submenu' && sub.rows.map((r) => (r.kind === 'action' ? [r.label, r.disabledReason ?? null] : r.kind))).toEqual([
      ['main', 'Checked out'], ['feature/x', null], ['origin/only-remote', null], 'separator', ['Detached HEAD at aaaaaaa', null],
    ]);
  });
  it('Reset X to this commit: Soft, Mixed, Hard, not on HEAD, greyed mid-rebase', () => {
    const row = buildMenu('commit', t, env()).find((r) => r.kind === 'action' && r.id === 'commit.reset');
    expect(row?.kind === 'action' && [row.label, row.variants?.map((v) => [v.label, v.tooltip])]).toEqual(['Reset main to this commit', [['Soft', 'keep all changes'], ['Mixed', 'keep working copy but reset index'], ['Hard', 'discard all changes']]]);
    expect(buildMenu('commit', { ...t, sha: 'zzz' }, env()).some((r) => r.kind === 'action' && r.id === 'commit.reset')).toBe(false);
    const busy = buildMenu('commit', t, env({ inProgress: 'rebase' })).find((r) => r.kind === 'action' && r.id === 'commit.reset');
    expect(busy?.kind === 'action' && busy.disabledReason).toBe('Finish or abort the rebase first');
    const detached = buildMenu('commit', t, env({ headBranch: null })).find((r) => r.kind === 'action' && r.id === 'commit.reset');
    expect(detached?.kind === 'action' && detached.label).toBe('Reset HEAD to this commit');
  });
  it('Reset sits early: in the first group, ahead of branch and integrate rows', () => {
    const ids = buildMenu('commit', t, env()).flatMap((r) => (r.kind === 'separator' ? [] : [r.id]));
    expect(ids.indexOf('commit.reset')).toBeLessThan(ids.indexOf('branch.checkout'));
  });
});
