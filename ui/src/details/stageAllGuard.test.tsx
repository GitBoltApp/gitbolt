import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FileChange } from '../api/gen/FileChange';
import type { GraphPayload } from '../api/gen/GraphPayload';
import { createRepoViewStore, RepoViewContext, type FileSection } from '../repo/store';
import { fakeServices } from '../repo/testServices';

const stagePaths = vi.hoisted(() => vi.fn(async () => true));
const stageAll = vi.hoisted(() => vi.fn(async () => true));
vi.mock('../stage/actions', async (orig) => ({
  ...(await orig<typeof import('../stage/actions')>()),
  stagePaths, stageAll,
  useWipCtx: () => ({ tabId: 't', repoId: 1, worktree: '/r' }),
  loadStaging: vi.fn(),
}));

import { WipSections } from './WipSections';

const file = (path: string, extra: Partial<FileChange> = {}): FileChange => ({ path, oldPath: null, status: 'M', additions: 1, deletions: 0, old: { kind: 'absent' }, new: { kind: 'worktree', worktree: '/r' }, submodule: false, ...extra });
const graph: GraphPayload = { rows: [], labels: [], maxLanes: 1, pinnedRef: null, head: { branch: null, target: null, detached: false, unborn: true }, truncated: false, worktrees: [] };
const sections = (...unstaged: FileChange[]): FileSection[] => [
  { title: 'Unstaged', spec: { kind: 'wip', worktree: '/r', staged: false }, list: { status: 'ready', data: { files: unstaged, added: 0, deleted: 0 } } },
  { title: 'Staged', spec: { kind: 'wip', worktree: '/r', staged: true }, list: { status: 'ready', data: { files: [], added: 0, deleted: 0 } } },
];
const show = (s: FileSection[]) => render(<RepoViewContext value={createRepoViewStore(1, '/r', graph, fakeServices())}><WipSections sections={s} /></RepoViewContext>);

beforeEach(() => { vi.clearAllMocks(); localStorage.clear(); });

describe('Stage all with conflicts (spec #2 §7.1)', () => {
  it('names the other unstaged paths while files are conflicted, so none is marked resolved', () => {
    show(sections(file('a.txt'), file('c.txt', { status: 'U', conflict: 'bothModified' })));
    fireEvent.click(screen.getByRole('button', { name: 'Stage all' }));
    expect(stagePaths).toHaveBeenCalledWith({ tabId: 't', repoId: 1, worktree: '/r' }, ['a.txt']);
    expect(stageAll).not.toHaveBeenCalled();
  });

  it('is plain Stage all otherwise', () => {
    show(sections(file('a.txt')));
    fireEvent.click(screen.getByRole('button', { name: 'Stage all' }));
    expect(stageAll).toHaveBeenCalled();
    expect(stagePaths).not.toHaveBeenCalled();
  });

  it('offers no Discard unstaged when only submodules are unstaged', () => {
    show(sections(file('sub', { submodule: true })));
    expect(screen.queryByRole('button', { name: 'Discard unstaged' })).toBeNull();
  });
});
