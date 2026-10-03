import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CommitTarget, MenuEnv, SelectionTarget } from '../menu/menuEnv';
import type { MenuRow } from '../menu/types';
import { useToast } from '../ui/toast';
import { fromHereRows, ontoRows, paletteRebase, paletteUsable, selectionFromHereRows, squashRows } from './menus';

const open = vi.hoisted(() => vi.fn(async () => true));
const squash = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('./open', () => ({ openRebaseEditor: open, REBASE_VIEW: 'irebase' }));
vi.mock('./squash', () => ({ squashSelection: squash }));
const rows = new Map<string, { parents: string[] }>([['c1', { parents: ['p1'] }], ['c2', { parents: ['c1'] }], ['m', { parents: ['a', 'b'] }], ['root', { parents: [] }]]);
const head = vi.hoisted(() => ({ branch: 'refs/heads/topic' as string | null }));
const wts = vi.hoisted(() => ({ list: [] as Array<{ path: string; inProgress: string | null }> }));
vi.mock('../app/tabStores', () => ({ tabStore: () => ({ getState: () => ({ indexById: new Map([...rows.keys()].map((k, i) => [k, i])), graph: { rows: [...rows.values()], head, worktrees: wts.list } }) }) }));
vi.mock('../write/ctx', () => ({ writeCtx: (tabId: string) => ({ tabId, repoId: 1, worktree: '/r' }) }));
const locals = vi.hoisted(() => ({ list: [] as Array<{ name: string; upstream: string | null; gone: boolean }> }));
vi.mock('../app/runtime', () => ({ useRuntime: { getState: () => ({ tabs: { t1: { sidebar: { locals: locals.list } } } }) } }));

const env = (over: Partial<MenuEnv> = {}) => ({ headBranch: 'topic', headSha: 'h', inProgress: null, write: { tabId: 't1', repoId: 1, worktree: '/r' }, isAncestor: () => true, ...over }) as unknown as MenuEnv;
const label = (name: string, sha = 'm1'): CommitTarget => ({ sha, mrRefs: [], isWip: false, isStash: false, branch: { name, local: `refs/heads/${name}`, remotes: [] } });
const commit = (sha: string): CommitTarget => ({ sha, mrRefs: [], isWip: false, isStash: false, branch: null });
const act = (r: MenuRow[]) => r.filter((x): x is Extract<MenuRow, { kind: 'action' }> => x.kind === 'action');
const sel: SelectionTarget = { commits: [{ oid: 'c2', summary: 'two', merge: false }, { oid: 'c1', summary: 'one', merge: false }] };

beforeEach(() => { open.mockClear(); squash.mockClear(); wts.list = []; });

describe('interactive rebase menu rows (spec #3 §4.3)', () => {
  it('a branch chip: "Interactive rebase X onto Y", greyed while busy, hidden when there is nothing to rebase', () => {
    const [row] = act(ontoRows(label('main'), env({ isAncestor: () => false })));
    expect(row.label).toBe('Interactive rebase topic onto main');
    row.run();
    expect(open).toHaveBeenCalledWith('t1', { branch: 'topic', base: 'main' });
    expect(act(ontoRows(label('main'), env({ inProgress: 'rebase', isAncestor: () => false })))[0].disabledReason).toBe('Finish or abort the rebase first');
    expect(ontoRows(label('topic'), env())).toEqual([]);
    expect(ontoRows(label('ahead'), env({ isAncestor: (a: string) => a === 'h' }))).toEqual([]);
  });

  it('a remote-only chip names the remote branch', () => {
    const t: CommitTarget = { sha: 'm1', mrRefs: [], isWip: false, isStash: false, branch: { name: 'main', local: null, remotes: [{ fullName: 'refs/remotes/origin/main', remote: 'origin' }] } };
    const [row] = act(ontoRows(t, env({ isAncestor: () => false })));
    expect(row.label).toBe('Interactive rebase topic onto origin/main');
    row.run();
    expect(open).toHaveBeenCalledWith('t1', { branch: 'topic', base: 'origin/main' });
  });

  it('a commit: "Interactive rebase from here" from its parent; hidden on merges, roots and other branches', () => {
    const [row] = act(fromHereRows(commit('c1'), env()));
    expect(row.label).toBe('Interactive rebase from here');
    row.run();
    expect(open).toHaveBeenLastCalledWith('t1', { branch: 'topic', base: 'p1' });
    expect(fromHereRows(commit('m'), env())).toEqual([]);
    expect(fromHereRows(commit('root'), env())).toEqual([]);
    expect(fromHereRows(commit('c1'), env({ isAncestor: () => false }))).toEqual([]);
    expect(act(fromHereRows(commit('c1'), env({ headBranch: null })))).toEqual([]);
    expect(act(fromHereRows(commit('c1'), env({ inProgress: 'merge' })))[0].disabledReason).toBe('Finish or abort the merge first');
  });

  it('a selection: Squash with "Squash interactively…", and Interactive rebase from its oldest', () => {
    const [sq] = act(squashRows(sel, env()));
    expect(sq.label).toBe('Squash');
    expect(sq.variants?.[0].label).toBe('Squash interactively…');
    sq.run();
    expect(squash).toHaveBeenCalledWith('t1', 'topic', ['c2', 'c1'], 'p1', false);
    sq.variants![0].run();
    expect(squash).toHaveBeenLastCalledWith('t1', 'topic', ['c2', 'c1'], 'p1', true);
    act(selectionFromHereRows(sel, env()))[0].run();
    expect(open).toHaveBeenLastCalledWith('t1', { branch: 'topic', base: 'p1' });
    const withMerge: SelectionTarget = { commits: [{ oid: 'm', summary: 'merge', merge: true }, ...sel.commits] };
    expect(squashRows(withMerge, env())).toEqual([]);
  });

  it('a selection with a commit outside HEAD\'s branch, or a root as its oldest, shows no rows', () => {
    expect(squashRows(sel, env({ isAncestor: (a: string) => a !== 'c2' }))).toEqual([]);
    const rooted: SelectionTarget = { commits: [{ oid: 'c1', summary: 'one', merge: false }, { oid: 'root', summary: 'root', merge: false }] };
    expect(squashRows(rooted, env())).toEqual([]);
    expect(selectionFromHereRows(rooted, env())).toEqual([]);
  });

  it('an operation in progress beats a detached HEAD: the rows show, greyed', () => {
    const rebasing = env({ headBranch: null, inProgress: 'rebase', isAncestor: () => false });
    const reason = (r: MenuRow[]) => act(r).map((x) => [x.label, x.disabledReason]);
    expect(reason(ontoRows(label('main'), rebasing))).toEqual([['Interactive rebase HEAD onto main', 'Finish or abort the rebase first']]);
    const inBranch = env({ headBranch: null, inProgress: 'rebase' });
    expect(reason(fromHereRows(commit('c1'), inBranch))).toEqual([['Interactive rebase from here', 'Finish or abort the rebase first']]);
    expect(reason(squashRows(sel, inBranch))).toEqual([['Squash', 'Finish or abort the rebase first']]);
    expect(reason(selectionFromHereRows(sel, inBranch))).toEqual([['Interactive rebase from here', 'Finish or abort the rebase first']]);
  });

  it('a detached HEAD hides every row', () => {
    const detached = env({ headBranch: null, isAncestor: () => false });
    expect(ontoRows(label('main'), detached)).toEqual([]);
    expect(fromHereRows(commit('c1'), detached)).toEqual([]);
    expect(squashRows(sel, detached)).toEqual([]);
    expect(selectionFromHereRows(sel, detached)).toEqual([]);
  });
});

describe('the palette\'s "Interactive rebase…" (Ruling 12)', () => {
  it('no upstream: a toast says where to start it', () => {
    head.branch = 'refs/heads/topic';
    locals.list = [{ name: 'topic', upstream: null, gone: false }];
    paletteRebase('t1');
    expect(open).not.toHaveBeenCalled();
    expect(useToast.getState().message).toBe('topic has no upstream: open "Interactive rebase topic onto …" from a branch\'s menu');
  });

  it('an operation in progress: a toast says to finish it first, offered even on the detached HEAD a rebase leaves', () => {
    head.branch = null;
    locals.list = [{ name: 'topic', upstream: 'refs/remotes/origin/topic', gone: false }];
    wts.list = [{ path: '/r', inProgress: 'rebase' }];
    expect(paletteUsable('t1')).toBe(true);
    paletteRebase('t1');
    expect(open).not.toHaveBeenCalled();
    expect(useToast.getState().message).toBe('Finish or abort the rebase first');
    wts.list = [];
    expect(paletteUsable('t1')).toBe(false);
  });

  it('HEAD\'s branch onto its upstream', () => {
    head.branch = 'refs/heads/topic';
    locals.list = [{ name: 'topic', upstream: 'refs/remotes/origin/topic', gone: false }];
    paletteRebase('t1');
    expect(open).toHaveBeenCalledWith('t1', { branch: 'topic', base: 'origin/topic' });
  });

  it('no upstream (or a gone one): a toast says where to start it', () => {
    head.branch = 'refs/heads/topic';
    locals.list = [{ name: 'topic', upstream: 'refs/remotes/origin/topic', gone: true }];
    paletteRebase('t1');
    expect(open).not.toHaveBeenCalled();
    expect(useToast.getState().message).toBe('topic has no upstream: open "Interactive rebase topic onto …" from a branch\'s menu');
  });

  it('a detached HEAD: nothing', () => {
    head.branch = null;
    paletteRebase('t1');
    expect(open).not.toHaveBeenCalled();
  });
});
