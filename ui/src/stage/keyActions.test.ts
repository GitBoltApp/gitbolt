import { beforeEach, describe, expect, it, vi } from 'vitest';

const stagePaths = vi.hoisted(() => vi.fn(async () => true));
const unstageFiles = vi.hoisted(() => vi.fn(async () => true));
const stageAll = vi.hoisted(() => vi.fn(async () => true));
const unstageAll = vi.hoisted(() => vi.fn(async () => true));
vi.mock('./actions', async (orig) => ({ ...(await orig<typeof import('./actions')>()), stagePaths, unstageFiles, stageAll, unstageAll }));

import { actionForCombo, getAction, runAction } from '../app/actions';
import { lend } from '../app/lent';
import { activeTabWith } from '../app/testShell';
import type { FileListPayload } from '../api/gen/FileListPayload';
import type { DiffTarget } from '../repo/store';
import { wipKey } from '../repo/wipLists';
import './keyActions';

const target = (staged: boolean, path = 'a.txt', status = 'M', oldPath: string | null = null): DiffTarget =>
  ({ key: `${wipKey('/t', staged)}|${path}`, path, oldPath, status, old: { kind: 'absent' }, new: { kind: 'worktree', worktree: '/t' }, view: 'diff' }) as DiffTarget;

const list = (files: Array<{ path: string; status: string }>) => ({ files: files.map((f) => ({ ...f, oldPath: null })), added: 0, deleted: 0, version: 1 }) as unknown as FileListPayload;

function withDiff(diff: DiffTarget | null, lists: { staged?: FileListPayload; unstaged?: FileListPayload } = {}) {
  const store = activeTabWith();
  store.setState({ diff });
  const wip = store.getState().services.wip;
  vi.spyOn(wip, 'peek').mockImplementation((k: string) => (k === wipKey('/t', true) ? lists.staged : k === wipKey('/t', false) ? lists.unstaged : undefined) as never);
  store.setState({ selection: { kind: 'wip', index: 0, worktree: '/t' } as never });
  return store;
}

beforeEach(() => vi.clearAllMocks());

describe('Ctrl+Shift+S: stage or unstage the open file', () => {
  it('stages an unstaged file, both paths of a rename', () => {
    withDiff(target(false, 'new.txt', 'R', 'old.txt'));
    expect(actionForCombo('Ctrl+Shift+S')?.id).toBe('stage.file');
    expect(runAction('stage.file')).toBe(true);
    expect(stagePaths).toHaveBeenCalledWith({ tabId: 't', repoId: 1, worktree: '/t' }, ['new.txt', 'old.txt']);
  });

  it('unstages a staged file', () => {
    withDiff(target(true, 'new.txt', 'R', 'old.txt'));
    expect(actionForCombo('Ctrl+Shift+S')?.id).toBe('stage.unstageFile');
    runAction('stage.unstageFile');
    expect(unstageFiles).toHaveBeenCalledWith({ tabId: 't', repoId: 1, worktree: '/t' }, [{ path: 'new.txt', oldPath: 'old.txt' }]);
  });

  it("isn't for a conflicted file, a commit's file or no file", () => {
    withDiff(target(false, 'c.txt', 'U'));
    expect(actionForCombo('Ctrl+Shift+S')).toBeUndefined();
    withDiff({ ...target(false), key: '{"kind":"commit","id":"abc"}|a.txt' });
    expect(actionForCombo('Ctrl+Shift+S')).toBeUndefined();
    withDiff(null);
    expect(actionForCombo('Ctrl+Shift+S')).toBeUndefined();
  });
});

describe('Ctrl+Shift+D: the hunk or lines at the diff cursor', () => {
  it('runs what the open diff lent, and is off without one', () => {
    withDiff(target(false));
    expect(actionForCombo('Ctrl+Shift+D')).toBeUndefined();
    const fn = vi.fn();
    const off = lend('stage.hunk', 't', fn);
    expect(actionForCombo('Ctrl+Shift+D')?.id).toBe('stage.hunk');
    expect(getAction('stage.hunk')?.label).toBe('Stage the hunk or lines at the cursor');
    runAction('stage.hunk');
    expect(fn).toHaveBeenCalledOnce();
    withDiff(target(true));
    expect(getAction('stage.hunk')?.label).toBe('Unstage the hunk or lines at the cursor');
    off();
  });
});

describe('Stage all / Unstage all (palette)', () => {
  it('stage everything, or only the unconflicted paths while files are conflicted', () => {
    withDiff(null, { unstaged: list([{ path: 'a', status: 'M' }]), staged: list([]) });
    expect(runAction('stage.all')).toBe(true);
    expect(stageAll).toHaveBeenCalledWith({ tabId: 't', repoId: 1, worktree: '/t' });
    expect(runAction('stage.unstageAll')).toBe(false);
    withDiff(null, { unstaged: list([{ path: 'a', status: 'M' }, { path: 'c', status: 'U' }]), staged: list([{ path: 's', status: 'M' }]) });
    runAction('stage.all');
    expect(stagePaths).toHaveBeenCalledWith({ tabId: 't', repoId: 1, worktree: '/t' }, ['a']);
    expect(runAction('stage.unstageAll')).toBe(true);
    expect(unstageAll).toHaveBeenCalledOnce();
  });
});
