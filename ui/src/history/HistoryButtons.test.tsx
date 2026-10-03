import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { GraphPayload } from '../api/gen/GraphPayload';
import { RepoContext } from '../app/repoContext';
import { createRepoViewStore, RepoViewContext, targetFor } from '../repo/store';
import { fakeServices } from '../repo/testServices';

vi.mock('../api/client', () => ({ api: {} }));
const openFileHistory = vi.hoisted(() => vi.fn(() => true));
vi.mock('./open', () => ({ openFileHistory }));
const { HistoryButtons } = await import('./HistoryButtons');

const A = 'a'.repeat(40);
const graph = { rows: [{ id: A, kind: 'commit', lane: 0, color: 0, segments: [], summary: 's', bodyFirstLine: '', authorName: 'A', authorEmail: 'a@x', authorTime: 0, committerTime: 0, parents: [], mrRefs: [], wip: null }], labels: [], maxLanes: 1, pinnedRef: null, head: { branch: 'refs/heads/main', target: A, detached: false, unborn: false }, truncated: false, worktrees: [] } as unknown as GraphPayload;
const file = { path: 'src/story.txt', oldPath: null, status: 'M', additions: 1, deletions: 1, old: { kind: 'object' as const, oid: 'o'.repeat(40) }, new: { kind: 'object' as const, oid: 'n'.repeat(40) }, submodule: false };

function mount(status = 'M', spec: object = { kind: 'commit', id: A, parent: 0 }, binary = false) {
  const store = createRepoViewStore(1, '/r', graph, fakeServices());
  render(
    <RepoContext value={{ tabId: 't1', repoId: 1, path: '/r', worktree: '/r', info: null }}>
      <RepoViewContext value={store}><HistoryButtons target={targetFor({ ...file, status }, spec as never)} binary={binary} /></RepoViewContext>
    </RepoContext>,
  );
}

describe('the diff toolbar\'s Blame | History (spec #3 §4.2)', () => {
  it('opens File History for the open file at its commit, with or without Blame', () => {
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'History' }));
    expect(openFileHistory).toHaveBeenLastCalledWith('t1', { path: 'src/story.txt', rev: A }, false);
    fireEvent.click(screen.getByRole('button', { name: 'Blame' }));
    expect(openFileHistory).toHaveBeenLastCalledWith('t1', { path: 'src/story.txt', rev: A }, true);
  });

  it('a file new in the working tree keeps the group, disabled, with a tooltip saying why (no layout shift)', () => {
    openFileHistory.mockClear();
    mount('A', { kind: 'wip', worktree: '/r', staged: false });
    expect(screen.getByRole('group', { name: 'History' })).toBeInTheDocument();
    for (const name of ['Blame', 'History']) {
      const b = screen.getByRole('button', { name });
      expect(b).toHaveAttribute('aria-disabled', 'true');
      fireEvent.click(b);
      fireEvent.mouseEnter(b);
      expect(screen.getByRole('tooltip')).toHaveTextContent('No history yet: the file is new');
      fireEvent.mouseLeave(b);
    }
    expect(openFileHistory).not.toHaveBeenCalled();
  });

  it('a binary: Blame is disabled with a tooltip saying why; History stays', () => {
    openFileHistory.mockClear();
    mount('M', { kind: 'commit', id: A, parent: 0 }, true);
    const blame = screen.getByRole('button', { name: 'Blame' });
    expect(blame).toHaveAttribute('aria-disabled', 'true');
    fireEvent.click(blame);
    fireEvent.mouseEnter(blame);
    expect(screen.getByRole('tooltip')).toHaveTextContent("Blame isn't available for binary files");
    fireEvent.mouseLeave(blame);
    expect(openFileHistory).not.toHaveBeenCalled();
    const history = screen.getByRole('button', { name: 'History' });
    expect(history).not.toHaveAttribute('aria-disabled');
    fireEvent.click(history);
    expect(openFileHistory).toHaveBeenLastCalledWith('t1', { path: 'src/story.txt', rev: A }, false);
  });
});
