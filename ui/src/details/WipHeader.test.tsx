import { act, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { GraphPayload } from '../api/gen/GraphPayload';
import type { RowPayload } from '../api/gen/RowPayload';
import type { WipPayload } from '../api/gen/WipPayload';
import { createRepoViewStore, RepoViewContext } from '../repo/store';
import { fakeServices } from '../repo/testServices';
import { WipHeader } from './WipHeader';

const wipRow = (wip: WipPayload): RowPayload => ({ id: `wip:${wip.worktreePath}`, kind: 'wip', lane: 0, color: 0, segments: [], summary: '', bodyFirstLine: '', authorName: '', authorEmail: '', authorTime: 0, committerTime: 0, parents: [], mrRefs: [], wip });
const graphOf = (...rows: RowPayload[]): GraphPayload => ({ rows, labels: [], maxLanes: 1, pinnedRef: null, head: { branch: null, target: null, detached: false, unborn: true }, truncated: false });

function renderSelected(graph: GraphPayload, index: number) {
  const store = createRepoViewStore(1, '/r', graph, fakeServices());
  act(() => store.getState().selectRow(index));
  render(<RepoViewContext value={store}><WipHeader /></RepoViewContext>);
}

describe('WipHeader', () => {
  it('shows // WIP, the worktree name and the counts, with no stage or discard controls (#2)', () => {
    renderSelected(graphOf(wipRow({ worktreePath: '/r-hotfix', worktreeName: 'hotfix', modified: 2, added: 1, deleted: 3, conflicted: 0 })), 0);
    expect(screen.getByTestId('wip-header')).toHaveTextContent('// WIP hotfix ✎2 +1 −3');
    expect(screen.queryAllByRole('button')).toHaveLength(0);
  });

  it('names the main worktree "Working tree"', () => {
    renderSelected(graphOf(wipRow({ worktreePath: '/r', worktreeName: null, modified: 1, added: 0, deleted: 0, conflicted: 0 })), 0);
    expect(screen.getByTestId('wip-header')).toHaveTextContent('// WIP Working tree ✎1');
  });
});
