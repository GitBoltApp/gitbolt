import { render, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { InProgress } from '../api/gen/InProgress';
import { readWipDraft, writeWipDraft } from '../commit/draft';

const h = vi.hoisted(() => ({
  inProgress: null as unknown,
  settlePaused: vi.fn(),
  selectCommit: vi.fn(),
}));

vi.mock('../api/client', () => ({ api: { settlePaused: h.settlePaused } }));
vi.mock('../app/graphNav', () => ({ selectCommit: h.selectCommit }));
vi.mock('../app/ops', () => ({ useOps: (sel: (s: { ops: object }) => unknown) => sel({ ops: {} }) }));
vi.mock('../undo/store', () => ({ journalKey: () => 'k', useJournal: (sel: (s: { states: object }) => unknown) => sel({ states: {} }) }));
vi.mock('../app/runtime', () => ({
  useRuntime: (sel: (s: unknown) => unknown) => sel({ tabs: { t: { repo: { id: 1, path: '/r' }, worktree: '/r' } } }),
  worktreeOf: () => '/r',
}));
vi.mock('../repo/store', () => ({
  useRepoView: (sel: (s: unknown) => unknown) =>
    sel({ repoPath: '/r', graph: { rows: [{ id: 'wip:/r', wip: { worktreePath: '/r' } }], labels: [], inProgress: { '/r': h.inProgress }, worktrees: [{ path: '/r', branch: 'main' }], head: { branch: 'other' } } }),
}));
vi.mock('../write/client', () => ({ runWrite: async (_c: unknown, send: () => Promise<unknown>) => send() }));

const merge = (conflicted: number, head = 'f'): InProgress => ({ kind: 'merge', mergeHead: head.repeat(40), message: "Merge branch 'feature/x'\n", conflicted });

async function show(tab = 't') {
  const { ConflictBanner } = await import('./ConflictBanner');
  return render(<ConflictBanner tab={{ id: tab } as never} />);
}

describe('the operation watcher (ux round 1: no window-wide bar)', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
    writeWipDraft('/r', '/r', { summary: 'Mine', description: '' });
  });

  it('draws nothing: the status and the buttons are the commit panel\'s', async () => {
    h.inProgress = merge(2);
    const { container } = await show();
    expect(container).toBeEmptyDOMElement();
  });

  it('adds MERGE_MSG to the WIP draft once per merge (§8.2)', async () => {
    h.inProgress = merge(1);
    await show();
    await waitFor(() => expect(readWipDraft('/r', '/r')).toEqual({ summary: 'Mine', description: "Merge branch 'feature/x'" }));
  });

  it('selects the WIP row once per stop, so its commit panel shows the operation', async () => {
    h.inProgress = merge(1, 'a');
    const first = await show('t');
    await waitFor(() => expect(h.selectCommit).toHaveBeenCalledWith('t', 'wip:/r'));
    first.unmount();
    h.selectCommit.mockClear();
    await show('t');
    expect(h.selectCommit).not.toHaveBeenCalled();
  });
});
