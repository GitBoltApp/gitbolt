import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { RepoContext } from '../app/repoContext';
import { discardAll } from '../stage/actions';
import { useStaging } from '../stage/store';
import type { GraphPayload } from '../api/gen/GraphPayload';
import type { RowPayload } from '../api/gen/RowPayload';
import type { WipPayload } from '../api/gen/WipPayload';
import type { FileListPayload } from '../api/gen/FileListPayload';
import { Loader } from '../data/loader';
import { Lru } from '../data/lru';
import { createRepoViewStore, RepoViewContext } from '../repo/store';
import { fakeServices } from '../repo/testServices';
import { WipHeader } from './WipHeader';

vi.mock('../stage/actions', async (original) => ({ ...(await original<typeof import('../stage/actions')>()), discardAll: vi.fn(async () => true) }));

/** File lists load at once (empty): the panel shows a selection once its lists are in. */
const change = (path: string): FileListPayload['files'][number] => ({ path, oldPath: null, status: 'M', additions: 1, deletions: 0, old: { kind: 'absent' }, new: { kind: 'worktree', worktree: '/r' }, submodule: false });
const loaded = (...paths: string[]) => fakeServices({ files: new Loader(async (): Promise<FileListPayload> => ({ files: paths.map(change), added: 0, deleted: 0 }), new Lru(8)) });

const wipRow = (wip: WipPayload): RowPayload => ({ id: `wip:${wip.worktreePath}`, kind: 'wip', lane: 0, color: 0, segments: [], summary: '', bodyFirstLine: '', authorName: '', authorEmail: '', authorTime: 0, committerTime: 0, parents: [], mrRefs: [], wip });
const graphOf = (...rows: RowPayload[]): GraphPayload => ({ rows, labels: [], maxLanes: 1, pinnedRefs: [], head: { branch: null, target: null, detached: false, unborn: true }, truncated: false, worktrees: [] });

async function renderSelected(graph: GraphPayload, index: number, ...paths: string[]) {
  const store = createRepoViewStore(1, '/r', graph, loaded(...paths));
  await act(async () => store.getState().selectRow(index));
  render(<RepoViewContext value={store}><WipHeader /></RepoViewContext>);
}

describe('WipHeader', () => {
  it('reads "N file changes on [branch]" and Discard all (2B); the branch is the worktree label\'s', async () => {
    const g = graphOf(wipRow({ worktreePath: '/r-hotfix', worktreeName: 'hotfix', modified: 2, added: 1, deleted: 3, renamed: 0, conflicted: 0 }));
    g.labels = [{ row: 1, name: 'hotfix-branch', local: 'hotfix-branch', remotes: [], tag: false, isHead: false, worktree: '/r-hotfix', checkedOut: null }];
    await renderSelected(g, 0, 'a.txt', 'b.txt');
    const header = screen.getByTestId('wip-header');
    expect(header).toHaveTextContent('2 file changes on hotfix-branch');
    expect(header.querySelector('.wip-branch')).toHaveTextContent('hotfix-branch');
    expect(screen.getAllByRole('button').map((b) => b.getAttribute('aria-label'))).toEqual(['Discard all']);
    // The open file's bar box (K5/K6); no separate "// WIP" title line (K36).
    expect(header).toHaveClass('panel-bar');
    expect(header).not.toHaveTextContent('// WIP');
  });

  it('the main worktree is on HEAD\'s branch, and one change is singular', async () => {
    const g = graphOf(wipRow({ worktreePath: '/r', worktreeName: null, modified: 1, added: 0, deleted: 0, renamed: 0, conflicted: 0 }));
    g.head = { branch: 'refs/heads/dev', target: null, detached: false, unborn: false };
    await renderSelected(g, 0, 'a.txt');
    expect(screen.getByTestId('wip-header')).toHaveTextContent('1 file change on dev');
  });

  it('Discard all is disabled mid-merge or rebase: "Abort instead" (spec #2 §7.2)', async () => {
    const g = graphOf(wipRow({ worktreePath: '/r', worktreeName: null, modified: 1, added: 0, deleted: 0, renamed: 0, conflicted: 0 }));
    g.worktrees = [{ path: '/r', inProgress: 'merge' } as GraphPayload['worktrees'][number]];
    await renderSelected(g, 0, 'a.txt');
    expect(screen.getByRole('button', { name: 'Discard all' })).toHaveAttribute('aria-disabled', 'true');
  });
});

// UX R1 C.2: Discard all sends the files it confirms, and waits for its own answer.
describe('WipHeader Discard all (UX R1 C.2)', () => {
  const ctx = { tabId: 't', repoId: 1, path: '/r', worktree: '/r', info: null };
  it('sends the files the panel shows, a rename\'s both paths', async () => {
    const g = graphOf(wipRow({ worktreePath: '/r', worktreeName: null, modified: 1, added: 0, deleted: 0, renamed: 1, conflicted: 0 }));
    const files = [change('a.txt'), { ...change('new.txt'), oldPath: 'old.txt', status: 'R' }];
    const store = createRepoViewStore(1, '/r', g, fakeServices({ files: new Loader(async (): Promise<FileListPayload> => ({ files, added: 0, deleted: 0 }), new Lru(8)) }));
    await act(async () => store.getState().selectRow(0));
    render(<RepoContext value={ctx}><RepoViewContext value={store}><WipHeader /></RepoViewContext></RepoContext>);
    fireEvent.click(screen.getByRole('button', { name: 'Discard all' }));
    expect(discardAll).toHaveBeenCalledWith({ tabId: 't', repoId: 1, worktree: '/r' }, 2, ['a.txt', 'new.txt', 'old.txt']);
  });

  it('is disabled while one runs: "Discarding…"', async () => {
    useStaging.getState().setDiscarding(1, '/r', true);
    const g = graphOf(wipRow({ worktreePath: '/r', worktreeName: null, modified: 1, added: 0, deleted: 0, renamed: 0, conflicted: 0 }));
    const store = createRepoViewStore(1, '/r', g, loaded('a.txt'));
    await act(async () => store.getState().selectRow(0));
    render(<RepoContext value={ctx}><RepoViewContext value={store}><WipHeader /></RepoViewContext></RepoContext>);
    expect(screen.getByRole('button', { name: 'Discard all' })).toHaveAttribute('aria-disabled', 'true');
    useStaging.getState().setDiscarding(1, '/r', false);
  });
});
