import { describe, expect, it } from 'vitest';
import type { FileChange } from '../api/gen/FileChange';
import type { FileListPayload } from '../api/gen/FileListPayload';
import type { GraphPayload } from '../api/gen/GraphPayload';
import { createRepoViewStore, targetFor } from '../repo/store';
import { fakeServices } from '../repo/testServices';
import { wipKey } from '../repo/wipLists';
import { leaveResolved } from './leaveResolved';

const graph: GraphPayload = { rows: [], labels: [], maxLanes: 1, pinnedRef: null, head: { branch: 'refs/heads/main', target: 'a'.repeat(40), detached: false, unborn: false }, truncated: false, worktrees: [] };
const spec = { kind: 'wip' as const, worktree: '/r', staged: false };
const change = (path: string, status = 'U'): FileChange => ({ path, oldPath: null, status, additions: null, deletions: null, old: { kind: 'absent' }, new: { kind: 'worktree', worktree: '/r' }, submodule: false });
const list = (...files: FileChange[]): FileListPayload => ({ files, added: 0, deleted: 0 });

function setup(open: string, held: FileListPayload | undefined) {
  const services = { wip: { peek: (k: string) => (k === wipKey('/r', false) ? held : undefined) } };
  const store = createRepoViewStore(1, '/r', graph, fakeServices());
  store.getState().openFile(targetFor(change(open), spec));
  store.getState().setFocus('files');
  return { store, services };
}

describe('a resolved open file leaves the merge tool (UX round 2)', () => {
  it('moves to the next conflicted file after it in the list', () => {
    const { store, services } = setup('b.txt', list(change('a.txt'), change('c.txt'), change('d.txt'), change('x.txt', 'M')));
    leaveResolved(store, services);
    expect(store.getState().diff).toEqual(targetFor(change('c.txt'), spec));
  });

  it('wraps round to the first one when none comes after it', () => {
    const { store, services } = setup('z.txt', list(change('a.txt'), change('c.txt')));
    leaveResolved(store, services);
    expect(store.getState().diff?.path).toBe('a.txt');
  });

  it('closes when no conflicted file is left, the focus where it was', () => {
    const { store, services } = setup('b.txt', list(change('b.txt', 'M')));
    leaveResolved(store, services);
    expect(store.getState().diff).toBeNull();
    expect(store.getState().focus).toBe('files');
  });

  it('stays while the file is still conflicted, or no list is held', () => {
    const still = setup('b.txt', list(change('a.txt'), change('b.txt')));
    leaveResolved(still.store, still.services);
    expect(still.store.getState().diff?.path).toBe('b.txt');
    const unknown = setup('b.txt', undefined);
    leaveResolved(unknown.store, unknown.services);
    expect(unknown.store.getState().diff?.path).toBe('b.txt');
  });

  it("the tool's own save names the file: it leaves even before the list says so", () => {
    const { store, services } = setup('b.txt', list(change('a.txt'), change('b.txt')));
    leaveResolved(store, services, 'b.txt');
    expect(store.getState().diff?.path).toBe('a.txt');
    // Already moved on: a second call is a no-op.
    leaveResolved(store, services, 'b.txt');
    expect(store.getState().diff?.path).toBe('a.txt');
  });

  it('leaves a non-conflict diff alone', () => {
    const { store, services } = setup('b.txt', list());
    store.getState().openFile(targetFor(change('m.txt', 'M'), spec));
    leaveResolved(store, services, 'm.txt');
    expect(store.getState().diff?.path).toBe('m.txt');
  });
});
