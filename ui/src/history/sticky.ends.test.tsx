import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DiffContentsPayload } from '../api/gen/DiffContentsPayload';
import type { FileChange } from '../api/gen/FileChange';
import type { GraphPayload } from '../api/gen/GraphPayload';
import type { RowPayload } from '../api/gen/RowPayload';
import { useTabViews } from '../app/tabStores';
import { EMPTY_GRAPH } from '../app/testShell';
import { Loader } from '../data/loader';
import { Lru } from '../data/lru';
import { centerViewOf, closeCenterView } from '../repo/centerView';
import { createRepoViewStore, RepoViewContext, targetFor, type DiffTarget, type RepoViewStore } from '../repo/store';
import { fakeServices } from '../repo/testServices';

vi.mock('../api/transport', () => ({ copyText: vi.fn(async () => {}), inTauri: () => false, createTransport: () => ({ call: () => Promise.reject(new Error('no backend')), subscribe: () => () => {} }) }));
vi.mock('../write/ctx', () => ({ writeCtx: (tabId: string, worktree?: string) => ({ tabId, repoId: 1, worktree: worktree ?? '/r' }) }));
vi.mock('../diff/monaco/load', () => ({ loadMonacoHost: async () => ({ goToChange: vi.fn() }) }));
await import('./feature');
const { openFileHistory } = await import('./open');
const { DiffToolbar } = await import('../diff/DiffToolbar');
const { fileMenuEnv } = await import('../menu/menuEnv');
const { openFileAt } = await import('../nav/repoPlaces');

const A = 'a'.repeat(40);
const row = (id: string): RowPayload => ({ id, kind: 'commit', lane: 0, color: 0, segments: [], summary: 's', bodyFirstLine: '', authorName: 'Ada', authorEmail: 'ada@example.com', authorTime: 0, committerTime: 0, parents: [], mrRefs: [], wip: null }) as RowPayload;
const graph: GraphPayload = { ...EMPTY_GRAPH, rows: [row(A)] };
const change = (path: string, status = 'M'): FileChange => ({ path, oldPath: null, status, additions: 1, deletions: 0, old: { kind: 'object', oid: '1'.repeat(40) }, new: { kind: 'object', oid: '2'.repeat(40) }, submodule: false });
const inCommit = (path: string): DiffTarget => targetFor(change(path), { kind: 'commit', id: A, parent: 0 });
const inWip = (path: string, status = 'M'): DiffTarget => targetFor(change(path, status), { kind: 'wip', worktree: '/r', staged: false });
const text = (t: string): DiffContentsPayload => ({ old: null, new: { size: t.length, binary: false, encoding: 'UTF-8', eol: 'lf', text: t, base64: null, hash: null }, tooLarge: false, eolOnly: false, image: false });

let store: RepoViewStore;
beforeEach(() => {
  const contents = new Loader(async (k: string) => text(k), new Lru<string, DiffContentsPayload>(10));
  store = createRepoViewStore(1, '/r', graph, fakeServices({ contents }));
  useTabViews.setState({ views: { t1: { repo: 1, services: store.getState().services, store } } });
  // Blame of a.txt, sticky.
  store.getState().openFile(inCommit('a.txt'));
  openFileHistory('t1', { path: 'a.txt', rev: A }, true);
});
afterEach(() => { closeCenterView('t1'); useTabViews.setState({ views: {} }); });

const ended = () => {
  expect(store.getState().stickyHistory).toBeNull();
  expect(centerViewOf('t1')).toBeNull();
};

describe('what ends sticky File History: a file asked for in a view of its own (UX)', () => {
  it('the toolbar\'s File View or Diff View, the pressed one too (a new file shown while sticky)', () => {
    store.getState().openFile(inWip('new.txt', 'A'));
    expect(store.getState().stickyHistory).toEqual({ blame: true });
    render(<RepoViewContext value={store}><DiffToolbar target={store.getState().diff!} canDiff canStep /></RepoViewContext>);
    fireEvent.click(screen.getByRole('button', { name: 'Diff View' }));
    ended();
    expect(store.getState().diff?.path).toBe('new.txt');
    store.getState().openFile(inWip('b.txt'));
    expect(centerViewOf('t1')).toBeNull();
  });

  it('the file menu\'s View ▸ Diff and View ▸ File', () => {
    fileMenuEnv(store).act.openDiff(inCommit('b.txt'));
    ended();
    expect(store.getState().diff).toMatchObject({ path: 'b.txt', view: 'diff' });
    openFileHistory('t1', { path: 'b.txt', rev: A }, true);
    fileMenuEnv(store).act.viewFile(inCommit('c.txt'));
    ended();
    expect(store.getState().diff).toMatchObject({ path: 'c.txt', view: 'file' });
  });

  it('a Markdown link or Back/Forward to a File View place (openFileAt)', async () => {
    expect(await openFileAt('t1', 'docs/guide.md', A)).toBe(true);
    ended();
    expect(store.getState().diff).toMatchObject({ path: 'docs/guide.md', view: 'file' });
  });
});
