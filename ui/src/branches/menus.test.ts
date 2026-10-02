import { describe, expect, it } from 'vitest';
import { buildMenu } from '../menu/registry';
import type { CommitTarget, MenuEnv } from '../menu/menuEnv';
import { anchorNow } from './menus';

const env = { write: { tabId: 't', repoId: 1, worktree: '/r' }, sidebar: { locals: [{ name: 'x', fullName: 'refs/heads/x', target: 'aaa', upstream: null, gone: false, checkedOut: null }], remotes: [], worktrees: [], stashes: [], tags: [] }, activeWorktree: '/r', worktreeShown: (p: string) => p, headBranch: 'main', headSha: 'zzz', labelsAt: () => [], inProgress: null } as unknown as MenuEnv;
const ids = (t: CommitTarget) => buildMenu('commit', t, env).flatMap((r) => (r.kind === 'action' ? [r.id] : []));

describe('branch rows (spec #2 §14)', () => {
  it('a local branch label gets Create branch here, Set upstream, Rename and Delete', () => {
    const t: CommitTarget = { sha: 'aaa', mrRefs: [], isWip: false, isStash: false, branch: { name: 'x', local: 'refs/heads/x', remotes: [] } };
    expect(ids(t)).toEqual(expect.arrayContaining(['branch.createHere', 'branch.setUpstream', 'branch.rename', 'branch.delete']));
  });
  it('a plain commit gets Create branch here only; a stash node none of them', () => {
    const plain: CommitTarget = { sha: 'bbb', mrRefs: [], isWip: false, isStash: false, branch: null };
    expect(ids(plain).filter((i) => i.startsWith('branch.'))).toEqual(['branch.createHere']);
    expect(ids({ ...plain, isStash: true }).filter((i) => i.startsWith('branch.'))).toEqual([]);
  });
  it('anchors on the open context menu', () => {
    document.body.innerHTML = '<div class="ctx-menu"></div>';
    const el = document.querySelector('.ctx-menu')!;
    el.getBoundingClientRect = () => new DOMRect(5, 6, 7, 8);
    expect(anchorNow().x).toBe(5);
    document.body.innerHTML = '';
  });
});
