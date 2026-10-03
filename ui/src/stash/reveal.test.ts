import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DiffSpec } from '../api/gen/DiffSpec';
import type { FileChange } from '../api/gen/FileChange';
import type { FileListPayload } from '../api/gen/FileListPayload';
import type { GraphPayload } from '../api/gen/GraphPayload';
import type { RowPayload } from '../api/gen/RowPayload';
import { useRuntime } from '../app/runtime';
import { useTabViews } from '../app/tabStores';
import { Loader } from '../data/loader';
import { Lru } from '../data/lru';
import { useFileListPrefs } from '../files/fileListPrefs';
import { createRepoViewStore, type RepoViewStore } from '../repo/store';
import { fakeServices } from '../repo/testServices';
import { revealRestored, stashPaths } from './reveal';

const commit = (id: string): RowPayload => ({ id, kind: 'commit', lane: 0, color: 0, segments: [], summary: id, bodyFirstLine: '', authorName: '', authorEmail: '', authorTime: 0, committerTime: 0, parents: [], mrRefs: [], wip: null });
const wipRow: RowPayload = { ...commit('wip:/r'), kind: 'wip', wip: { worktreePath: '/r', worktreeName: null, modified: 2, added: 0, deleted: 0, renamed: 0, conflicted: 0 } };
const graphOf = (rows: RowPayload[]): GraphPayload => ({ rows, labels: [], maxLanes: 1, pinnedRef: null, head: { branch: 'refs/heads/main', target: 'a', detached: false, unborn: false }, truncated: false, worktrees: [] } as unknown as GraphPayload);
const file = (path: string): FileChange => ({ path, oldPath: null, status: 'M', additions: 1, deletions: 0, old: { kind: 'absent' }, new: { kind: 'worktree', worktree: '/r' }, submodule: false });
const list = (...paths: string[]): FileListPayload => ({ files: paths.map(file), added: 0, deleted: 0 });

/** Lists by spec: the stash commit holds b.txt; the WIP's unstaged list a.txt and b.txt. */
function setup(): RepoViewStore {
  useFileListPrefs.getState().set({ mode: 'path', sort: 'path', allFiles: false });
  const lists = (spec: DiffSpec): FileListPayload => (spec.kind === 'commit' ? list('b.txt') : spec.kind === 'wip' && !spec.staged ? list('a.txt', 'b.txt') : list());
  const services = fakeServices({ files: new Loader(async (k: string) => lists(JSON.parse(k) as DiffSpec), new Lru(16)) });
  const store = createRepoViewStore(1, '/r', graphOf([commit('a')]), services);
  useTabViews.setState({ views: { t: { repo: 1, services, store } } });
  return store;
}

afterEach(() => {
  useTabViews.setState({ views: {} });
  vi.useRealTimers();
});

describe('revealRestored (UX round 2: after a stash Apply/Pop)', () => {
  it('selects the WIP row once the refreshed graph shows it, and opens the first file the stash brought back', async () => {
    const store = setup();
    store.getState().selectRow(0);
    const paths = stashPaths('t', 'stash-oid');
    const done = revealRestored('t', '/r', paths);
    // The watcher's refresh lands: the graph now has the WIP row.
    store.getState().setGraph(graphOf([wipRow, commit('a')]));
    await done;
    const s = store.getState();
    expect(s.selection).toMatchObject({ kind: 'wip', worktree: '/r' });
    // b.txt, not a.txt: the stash held only b.txt.
    expect(s.diff?.path).toBe('b.txt');
    expect(s.focus).toBe('files');
  });

  it('a conflicted apply (open = false) selects the WIP row only', async () => {
    const store = setup();
    store.getState().setGraph(graphOf([wipRow, commit('a')]));
    await revealRestored('t', '/r', Promise.resolve(null), false);
    expect(store.getState().selection).toMatchObject({ kind: 'wip' });
    expect(store.getState().diff).toBeNull();
  });

  it('with no WIP row in sight it asks for a refresh, then gives up', async () => {
    vi.useFakeTimers();
    const store = setup();
    const refresh = vi.spyOn(useRuntime.getState(), 'refresh').mockResolvedValue();
    const done = revealRestored('t', '/r', Promise.resolve(null));
    await vi.advanceTimersByTimeAsync(5000);
    await done;
    expect(refresh).toHaveBeenCalledWith('t', { graphOnly: true });
    expect(store.getState().selection.kind).toBe('none');
  });
});
