import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FileChange } from '../api/gen/FileChange';
import type { GraphPayload } from '../api/gen/GraphPayload';
import { createRepoViewStore, RepoViewContext, type FileSection } from '../repo/store';
import { fakeServices } from '../repo/testServices';

const markResolved = vi.hoisted(() => vi.fn(async () => true));
vi.mock('../conflicts/resolve', () => ({ markResolved }));
vi.mock('../stage/actions', async (orig) => ({
  ...(await orig<typeof import('../stage/actions')>()),
  useWipCtx: () => ({ tabId: 't', repoId: 1, worktree: '/r' }),
  loadStaging: vi.fn(),
}));

import { WipSections } from './WipSections';
import { draftKey, useMergeDrafts } from '../conflicts/mergeDrafts';

const file = (path: string, extra: Partial<FileChange> = {}): FileChange => ({ path, oldPath: null, status: 'M', additions: 1, deletions: 0, old: { kind: 'absent' }, new: { kind: 'worktree', worktree: '/r' }, submodule: false, ...extra });
const graph: GraphPayload = { rows: [], labels: [], maxLanes: 1, pinnedRefs: [], head: { branch: null, target: null, detached: false, unborn: true }, truncated: false, worktrees: [] };
const sections = (...unstaged: FileChange[]): FileSection[] => [
  { title: 'Unstaged', spec: { kind: 'wip', worktree: '/r', staged: false }, list: { status: 'ready', data: { files: unstaged, added: 0, deleted: 0 } } },
  { title: 'Staged', spec: { kind: 'wip', worktree: '/r', staged: true }, list: { status: 'ready', data: { files: [], added: 0, deleted: 0 } } },
];

beforeEach(() => { vi.clearAllMocks(); localStorage.clear(); });

describe('Mark resolved on a Conflicted row (spec #2 §13.3)', () => {
  it('is the conflicted row\'s hover action; other rows have none', () => {
    render(<RepoViewContext value={createRepoViewStore(1, '/r', graph, fakeServices())}><WipSections sections={sections(file('a.txt'), file('src/c.txt', { status: 'U', conflict: 'bothModified' }))} /></RepoViewContext>);
    expect(screen.queryByRole('button', { name: 'Mark a.txt resolved' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Mark src/c.txt resolved' }));
    expect(markResolved).toHaveBeenCalledWith({ tabId: 't', repoId: 1, worktree: '/r' }, 'src/c.txt');
  });

  it('is greyed out while the merge tool holds unsaved work on the file (2D final I1)', () => {
    useMergeDrafts.setState({ drafts: { [draftKey('t', '/r', 'src/c.txt')]: { tabId: 't', repo: 1, worktree: '/r', path: 'src/c.txt', base: 'h', segments: [], eol: 'lf', picks: {}, text: 'x', spans: [], edited: [], typed: true } } });
    render(<RepoViewContext value={createRepoViewStore(1, '/r', graph, fakeServices())}><WipSections sections={sections(file('src/c.txt', { status: 'U', conflict: 'bothModified' }))} /></RepoViewContext>);
    const button = screen.getByRole('button', { name: 'Mark src/c.txt resolved' });
    expect(button).toHaveAttribute('aria-disabled', 'true');
    fireEvent.click(button);
    expect(markResolved).not.toHaveBeenCalled();
    useMergeDrafts.setState({ drafts: {} });
  });
});
