import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import type { GraphPayload } from '../api/gen/GraphPayload';
import type { RowPayload } from '../api/gen/RowPayload';
import { createCommitMessageCache } from '../api/commitMessages';
import { Loader } from '../data/loader';
import { Lru } from '../data/lru';
import { createRepoViewStore, type RepoViewStore } from '../repo/store';
import { fakeServices } from '../repo/testServices';
import { selectCommit } from './graphNav';
import { fetchCommitMessage, listTreeFiles, openFileView, startCompare, useDiffOpen } from './seams1b';
import { dropTabView, useTabViews } from './tabStores';

const row = (id: string, time: number, wip = false): RowPayload => ({ id, kind: wip ? 'wip' : 'commit', lane: 0, color: 0, segments: [], summary: id, bodyFirstLine: '', authorName: 'A', authorEmail: '', authorTime: time, committerTime: time, parents: [], mrRefs: [], wip: wip ? { worktreePath: '/r', worktreeName: null, added: 0, modified: 0, deleted: 0, conflicted: 0 } as RowPayload['wip'] : null });
const graph: GraphPayload = { rows: [row('wip:/r', 0, true), row('c2', 20), row('c1', 10)], labels: [], maxLanes: 1, pinnedRef: null, head: { branch: null, target: null, detached: false, unborn: false }, truncated: false };

function register(tabId: string) {
  const services = fakeServices({
    messages: createCommitMessageCache(async (id) => ({ id, summary: `Summary ${id}`, body: id === 'c2' ? 'Body line' : '' })),
    treeFiles: new Loader(async (id) => [`${id}/a.txt`, `${id}/b.txt`], new Lru(4)),
  });
  const store = createRepoViewStore(1, '/r', graph, services);
  useTabViews.setState((s) => ({ views: { ...s.views, [tabId]: { repo: 1, services, store } } }));
  return store;
}

describe('the 1B seams, through the tab\'s store (ruling R3)', () => {
  beforeEach(() => { useTabViews.setState({ views: {} }); });

  it('useDiffOpen follows the tab\'s open file, and is false for a tab with no view yet', () => {
    const { result, rerender } = renderHook(({ id }) => useDiffOpen(id), { initialProps: { id: 't' } });
    expect(result.current).toBe(false);
    let store!: RepoViewStore;
    act(() => { store = register('t'); });
    rerender({ id: 't' });
    expect(result.current).toBe(false);
    act(() => { expect(openFileView('t', 'c1', 'src/x.ts')).toBe(true); });
    expect(result.current).toBe(true);
    expect(store.getState().diff).toMatchObject({ path: 'src/x.ts', view: 'file', new: { kind: 'atCommit', commit: 'c1' } });
    act(() => store.getState().closeDiff());
    expect(result.current).toBe(false);
    act(() => dropTabView('t'));
    expect(result.current).toBe(false);
  });

  it('startCompare: two commits (from → to, as a click then a Ctrl+click, K27), or a commit with the tab\'s worktree', () => {
    const store = register('t');
    expect(startCompare('t', 'c2', 'c1')).toBe(true);
    expect(store.getState().selection).toEqual({ kind: 'compare', from: 'c2', to: 'c1' });
    expect(startCompare('t', 'c1', 'worktree')).toBe(true);
    expect(store.getState().selection).toEqual({ kind: 'compareWorktree', from: 'c1', worktree: '/r' });
    expect(startCompare('t', 'nope', 'c1')).toBe(false);
    expect(startCompare('other', 'c1', 'c2')).toBe(false);
  });

  it('commit messages and tree listings come from the tab\'s caches', async () => {
    register('t');
    await expect(fetchCommitMessage('t', 'c2')).resolves.toBe('Summary c2\n\nBody line');
    await expect(fetchCommitMessage('t', 'c1')).resolves.toBe('Summary c1');
    await expect(listTreeFiles('t', 'c1')).resolves.toEqual(['c1/a.txt', 'c1/b.txt']);
    await expect(fetchCommitMessage('none', 'c1')).rejects.toThrow();
  });

  it('selectCommit selects by id, optionally focusing the graph; false when not loaded', () => {
    const store = register('t');
    act(() => store.getState().setFocus('files'));
    expect(selectCommit('t', 'c1', { focus: true })).toBe(true);
    expect(store.getState().selection).toMatchObject({ kind: 'commit', id: 'c1', index: 2 });
    expect(store.getState().focus).toBe('graph');
    expect(selectCommit('t', 'deep')).toBe(false);
    expect(selectCommit('none', 'c1')).toBe(false);
  });
});
