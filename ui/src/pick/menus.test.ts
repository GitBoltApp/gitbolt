import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '../api/client';
import type { CommitTarget, MenuEnv, SelectionTarget } from '../menu/menuEnv';
import { shortSha } from '../format/sha';
import { buildMenu } from '../menu/registry';
import type { MenuRow } from '../menu/types';
import type { CommitRef } from '../repo/store';
import { pickRows } from './menus';

const ctx = { tabId: 't', repoId: 1, worktree: '/r' };
const [A, B, H] = ['a', 'b', 'h'].map((c) => c.repeat(40));
const c = (oid: string, merge = false): CommitRef => ({ oid, summary: `Fix ${oid[0]}`, merge });
const env = (over: Partial<MenuEnv> = {}) => ({ write: ctx, headBranch: 'main', headSha: H, inProgress: null, isAncestor: () => false, ...over }) as unknown as MenuEnv;
type Action = Extract<MenuRow, { kind: 'action' }>;
const actions = (rows: MenuRow[]) => rows.filter((r): r is Action => r.kind === 'action');
const labels = (rows: MenuRow[]) => actions(rows).map((r) => r.label);
const ok = { outcome: { status: 'done', commits: 1, committed: true }, journal: { undo: null, redo: null, undoBlocked: null, redoBlocked: null, banners: [], paused: null }, staging: { undo: null, redo: null, off: null }, wip: null } as never;

afterEach(() => vi.restoreAllMocks());

describe('Cherry-pick and Revert rows (spec #3 §4.3)', () => {
  it('one commit off HEAD: Cherry-pick onto main with No commit; no Revert', () => {
    const rows = pickRows([c(A)], env());
    expect(labels(rows)).toEqual(['Cherry-pick onto main']);
    expect(actions(rows)[0].variants?.map((v) => v.label)).toEqual(['No commit']);
  });
  it("a commit in HEAD's history: Revert only", () => {
    expect(labels(pickRows([c(A)], env({ isAncestor: () => true })))).toEqual(['Revert this commit']);
  });
  it('unknown ancestry shows both (the backend checks after the click)', () => {
    expect(labels(pickRows([c(A)], env({ isAncestor: () => null })))).toEqual(['Cherry-pick onto main', 'Revert this commit']);
  });
  it('a selection names its count', () => {
    expect(labels(pickRows([c(A), c(B)], env({ isAncestor: () => null })))).toEqual(['Cherry-pick 2 commits onto main', 'Revert 2 commits']);
  });
  it('a selection holding a merge commit offers no cherry-pick or revert (Review Focus 5)', () => {
    expect(pickRows([c(A), c(B, true)], env({ isAncestor: () => null }))).toEqual([]);
  });
  it('greys during another operation and on a detached HEAD', () => {
    expect(actions(pickRows([c(A)], env({ inProgress: 'rebase' })))[0].disabledReason).toBe('Finish or abort the rebase first');
    const detached = actions(pickRows([c(A)], env({ headBranch: null })));
    expect(detached[0].label).toBe('Cherry-pick onto HEAD');
    expect(detached[0].disabledReason).toBe('Check out a branch first');
  });
  it('greys both rows on an unborn HEAD', () => {
    const rows = actions(pickRows([c(A)], env({ headSha: null })));
    expect(rows.map((r) => r.label)).toEqual(['Cherry-pick onto main', 'Revert this commit']);
    expect(rows.map((r) => r.disabledReason)).toEqual(['Make a first commit first', 'Make a first commit first']);
    expect(rows.flatMap((r) => r.variants!.map((v) => v.disabledReason))).toEqual(['Make a first commit first', 'Make a first commit first']);
  });
  it('the label commits; the No commit variant stages', async () => {
    const pick = vi.spyOn(api, 'cherryPick').mockResolvedValue(ok);
    const [row] = actions(pickRows([c(A)], env()));
    row.run();
    await vi.waitFor(() => expect(pick).toHaveBeenCalledWith(1, '/r', [A], expect.objectContaining({ noCommit: false })));
    row.variants![0].run();
    await vi.waitFor(() => expect(pick).toHaveBeenLastCalledWith(1, '/r', [A], expect.objectContaining({ noCommit: true })));
  });
  it("a selection's Cherry-pick leaves out the commits already on HEAD; Revert keeps them all", async () => {
    const pick = vi.spyOn(api, 'cherryPick').mockResolvedValue(ok);
    const rows = actions(pickRows([c(A), c(B)], env({ isAncestor: (a) => (a === B ? true : null) })));
    expect(rows.map((r) => r.label)).toEqual(['Cherry-pick onto main', 'Revert 2 commits']);
    expect(rows[0].tooltip).toBe(`Apply ${shortSha(A)} Fix a on top of main`);
    rows[0].run();
    await vi.waitFor(() => expect(pick).toHaveBeenCalledWith(1, '/r', [A], expect.objectContaining({ noCommit: false })));
    const revert = vi.spyOn(api, 'revert').mockResolvedValue(ok);
    rows[1].run();
    await vi.waitFor(() => expect(revert).toHaveBeenCalledWith(1, '/r', [A, B], expect.anything()));
  });
  it('greys both rows, variants too, over conflicted files with nothing in progress', () => {
    const rows = actions(pickRows([c(A)], env({ isAncestor: () => null, conflicted: 2 })));
    expect(rows.map((r) => r.disabledReason)).toEqual(['Resolve conflicts first', 'Resolve conflicts first']);
    expect(rows.flatMap((r) => r.variants!.map((v) => v.disabledReason))).toEqual(['Resolve conflicts first', 'Resolve conflicts first']);
    expect(actions(pickRows([c(A)], env({ conflicted: 0 })))[0].disabledReason).toBeUndefined();
  });
  it('registered in the commit menu (from the loaded row) and the selection menu', () => {
    const t: CommitTarget = { sha: A, mrRefs: [], isWip: false, isStash: false, branch: null };
    const ids = (rows: MenuRow[]) => actions(rows).map((r) => r.id);
    expect(ids(buildMenu('commit', t, env({ commitInfo: () => ({ summary: 'Fix a', merge: false }) })))).toContain('commit.cherryPick');
    expect(ids(buildMenu('commit', t, env({ commitInfo: () => ({ summary: 'Merge x', merge: true }) })))).not.toContain('commit.cherryPick');
    expect(ids(buildMenu('commit', { ...t, isWip: true }, env()))).not.toContain('commit.cherryPick');
    const sel: SelectionTarget = { commits: [c(A), c(B)] };
    expect(ids(buildMenu('selection', sel, env({ isAncestor: () => null })))).toEqual(['commit.cherryPick', 'commit.revert']);
  });
});
