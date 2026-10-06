import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FileChange } from '../api/gen/FileChange';
import type { GraphPayload } from '../api/gen/GraphPayload';
import type { RowPayload } from '../api/gen/RowPayload';
import { useTabViews } from '../app/tabStores';
import { EMPTY_GRAPH } from '../app/testShell';
import { historyOf, navBack, navForward, placeKey, useNavHistory } from '../nav/history';
import { centerViewOf, centerViewOnTop, closeCenterView, openCenterView, registerCenterView } from '../repo/centerView';
import { createRepoViewStore, fileViewTarget, targetFor, type DiffTarget, type RepoViewStore } from '../repo/store';
import { fakeServices } from '../repo/testServices';
import type { FileHistoryArgs } from './model';

vi.mock('../api/client', async (orig) => ({ ...(await orig<typeof import('../api/client')>()), api: {} }));
vi.mock('../write/ctx', () => ({ writeCtx: (tabId: string, worktree?: string) => ({ tabId, repoId: 1, worktree: worktree ?? '/r' }) }));
// Registers File History's view, its sticky opener and its navigation place.
await import('./feature');
await import('../nav/repoPlaces');
const { openFileHistory } = await import('./open');
const { endStickyHistory } = await import('./sticky');

const A = 'a'.repeat(40);
const row = (id: string): RowPayload => ({ id, kind: 'commit', lane: 0, color: 0, segments: [], summary: 's', bodyFirstLine: '', authorName: 'Ada', authorEmail: 'ada@example.com', authorTime: 0, committerTime: 0, parents: [], mrRefs: [], wip: null }) as RowPayload;
const graph: GraphPayload = { ...EMPTY_GRAPH, rows: [row(A)] };
const change = (path: string, status = 'M'): FileChange => ({ path, oldPath: null, status, additions: 1, deletions: 0, old: { kind: 'object', oid: '1'.repeat(40) }, new: { kind: 'object', oid: '2'.repeat(40) }, submodule: false });
const inCommit = (path: string): DiffTarget => targetFor(change(path), { kind: 'commit', id: A, parent: 0 });
const inWip = (path: string, status = 'M', staged = false): DiffTarget => targetFor(change(path, status), { kind: 'wip', worktree: '/r', staged });

let t1: RepoViewStore;
let t2: RepoViewStore;
const view = (tabId = 't1') => centerViewOf(tabId);
const args = (tabId = 't1') => view(tabId)?.props as FileHistoryArgs | undefined;
const onTop = (tabId: string, store: RepoViewStore) => centerViewOnTop(view(tabId), store.getState().diff);

beforeEach(() => {
  t1 = createRepoViewStore(1, '/r', graph, fakeServices());
  t2 = createRepoViewStore(1, '/r', graph, fakeServices());
  useTabViews.setState({ views: { t1: { repo: 1, services: t1.getState().services, store: t1 }, t2: { repo: 1, services: t2.getState().services, store: t2 } } });
  useNavHistory.setState({ byTab: {} });
});
afterEach(() => { closeCenterView('t1'); closeCenterView('t2'); useTabViews.setState({ views: {} }); });

/** Blame (or History) open on a.txt, over its diff, as the toolbar opens it. */
function blameOn(path = 'a.txt', blame = true, target = inCommit(path)) {
  t1.getState().openFile(target);
  const wip = target.key.includes('wip');
  openFileHistory('t1', wip ? { path, rev: null, worktree: '/r' } : { path, rev: A }, blame);
}

describe('File History is sticky (UX: a file picked while it\'s open opens in it too)', () => {
  it('opening File History turns the tab\'s mode on: Blame, or History alone', () => {
    blameOn('a.txt', true);
    expect(t1.getState().stickyHistory).toEqual({ blame: true });
    openFileHistory('t1', { path: 'a.txt', rev: A }, false);
    expect(t1.getState().stickyHistory).toEqual({ blame: false });
  });

  it('another file picked opens File History for it, in the same mode, from the selection\'s revision', () => {
    blameOn('a.txt', true);
    t1.getState().openFile(inCommit('b.txt'));
    expect(args()).toEqual({ repoId: 1, worktree: '/r', path: 'b.txt', rev: A, blame: true, follow: true });
    expect(onTop('t1', t1)).toBe(true);
    expect(t1.getState().diff?.path).toBe('b.txt');
    // History stays History.
    openFileHistory('t1', { path: 'b.txt', rev: A }, false);
    t1.getState().openFile(inCommit('c.txt'));
    expect(args()).toMatchObject({ path: 'c.txt', blame: false });
  });

  it('a WIP file\'s history starts at its worktree\'s HEAD', () => {
    blameOn('a.txt', true, inWip('a.txt'));
    t1.getState().openFile(inWip('b.txt'));
    expect(args()).toEqual({ repoId: 1, worktree: '/r', path: 'b.txt', rev: null, blame: true, follow: true });
  });

  it('the mode follows File History\'s own Blame toggle', () => {
    blameOn('a.txt', true);
    t1.getState().setStickyHistory({ blame: false }); // what FileHistory does on its toggle
    t1.getState().openFile(inCommit('b.txt'));
    expect(args()).toMatchObject({ path: 'b.txt', blame: false });
  });

  it('the same file again (a whole-file stage moved it to Staged): File History stays as it is, on top', () => {
    blameOn('a.txt', true, inWip('a.txt'));
    const before = view();
    t1.getState().openFile(inWip('a.txt', 'M', true));
    expect(view()?.props).toBe(before?.props);
    expect(onTop('t1', t1)).toBe(true);
  });

  it('a file new in the working tree (no history) shows its Diff View; the mode stays for the next file', () => {
    blameOn('a.txt', true, inWip('a.txt'));
    t1.getState().openFile(inWip('new.txt', 'A'));
    expect(t1.getState().diff?.path).toBe('new.txt');
    expect(onTop('t1', t1)).toBe(false);
    expect(t1.getState().stickyHistory).toEqual({ blame: true });
    t1.getState().openFile(inWip('b.txt'));
    expect(args()).toMatchObject({ path: 'b.txt', blame: true });
    expect(onTop('t1', t1)).toBe(true);
  });

  it('closing File History ends the mode: the next file opens as usual', () => {
    blameOn('a.txt', true);
    closeCenterView('t1');
    expect(t1.getState().stickyHistory).toBeNull();
    t1.getState().openFile(inCommit('b.txt'));
    expect(view()).toBeNull();
    expect(t1.getState().diff?.path).toBe('b.txt');
  });

  it('another view in its place (the rebase editor) ends it too', () => {
    registerCenterView('sticky-probe', () => null);
    blameOn('a.txt', true);
    openCenterView('t1', 'sticky-probe', {});
    expect(t1.getState().stickyHistory).toBeNull();
  });

  it('a file asked for in a view of its own ends it, closing File History', () => {
    blameOn('a.txt', true);
    endStickyHistory('t1');
    expect(t1.getState().stickyHistory).toBeNull();
    expect(view()).toBeNull();
    t1.getState().openFile(inCommit('b.txt'));
    expect(view()).toBeNull();
  });

  it('is each tab\'s own', () => {
    blameOn('a.txt', true);
    expect(t2.getState().stickyHistory).toBeNull();
    t2.getState().openFile(inCommit('b.txt'));
    expect(view('t2')).toBeNull();
    expect(args('t1')?.path).toBe('a.txt');
  });
});

describe('sticky File History and Back / Forward', () => {
  const keys = () => historyOf('t1').places.map(placeKey);

  it('each File History opened is a place; Back and Forward show each file\'s again, in its mode', async () => {
    blameOn('a.txt', true);
    t1.getState().openFile(inCommit('b.txt'));
    expect(keys()).toEqual([`history:/r:${A}:a.txt`, `history:/r:${A}:b.txt`]);
    await navBack('t1');
    expect(args()).toEqual({ repoId: 1, worktree: '/r', path: 'a.txt', rev: A, blame: true });
    expect(historyOf('t1').cursor).toBe(0);
    await navForward('t1');
    expect(args()).toMatchObject({ path: 'b.txt', blame: true });
    expect(keys()).toHaveLength(2);
  });

  it('a file stepped to in File View while sticky adds no File View place of its own', () => {
    blameOn('a.txt', true);
    t1.getState().openFile(fileViewTarget('b.txt', A, { kind: 'commit', id: A, parent: 0 }));
    expect(keys()).toEqual([`history:/r:${A}:a.txt`, `history:/r:${A}:b.txt`]);
  });

  it('the place keeps the mode File History was left in', async () => {
    blameOn('a.txt', true);
    t1.getState().setStickyHistory({ blame: false });
    t1.getState().openFile(inCommit('b.txt'));
    await navBack('t1');
    expect(args()).toMatchObject({ path: 'a.txt', blame: false });
  });
});
