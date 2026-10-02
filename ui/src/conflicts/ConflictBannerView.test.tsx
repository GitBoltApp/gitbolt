import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { InProgress } from '../api/gen/InProgress';
import { readWipDraft, writeWipDraft } from '../commit/draft';

const h = vi.hoisted(() => ({
  inProgress: null as unknown,
  mergeAbort: vi.fn(),
  rebaseControl: vi.fn(),
  settlePaused: vi.fn(),
  confirm: vi.fn(),
}));

vi.mock('../api/client', () => ({ api: { mergeAbort: h.mergeAbort, rebaseControl: h.rebaseControl, settlePaused: h.settlePaused } }));
vi.mock('../ui/ConfirmDialog', () => ({ confirmAction: h.confirm }));
vi.mock('../app/graphNav', () => ({ selectCommit: vi.fn() }));
vi.mock('../commit/CommitBox', () => ({ focusCommitBox: vi.fn() }));
vi.mock('../app/ops', () => ({ useOps: (sel: (s: { ops: object }) => unknown) => sel({ ops: {} }) }));
vi.mock('../undo/store', () => ({ journalKey: () => 'k', useJournal: (sel: (s: { states: object }) => unknown) => sel({ states: {} }) }));
vi.mock('../app/runtime', () => ({
  useRuntime: (sel: (s: unknown) => unknown) => sel({ tabs: { t: { repo: { id: 1, path: '/r' }, worktree: '/r' } } }),
  worktreeOf: () => '/r',
}));
vi.mock('../repo/store', () => ({
  useRepoView: (sel: (s: unknown) => unknown) =>
    sel({ repoPath: '/r', graph: { rows: [], labels: [], inProgress: { '/r': h.inProgress }, worktrees: [{ path: '/r', branch: 'main' }], head: { branch: 'other' } } }),
}));
vi.mock('../write/client', () => ({
  runWrite: async (_c: unknown, send: () => Promise<unknown>, opts: { onSuccess?: () => Promise<void> } = {}) => {
    await send();
    await opts.onSuccess?.();
    return {};
  },
}));

const merge = (conflicted: number): InProgress => ({ kind: 'merge', mergeHead: 'f'.repeat(40), message: "Merge branch 'feature/x'\n", conflicted });

async function show() {
  const { ConflictBanner } = await import('./ConflictBanner');
  render(<ConflictBanner tab={{ id: 't' } as never} />);
}

describe('the conflict banner buttons', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
    writeWipDraft('/r', '/r', { summary: 'Mine', description: '' });
  });

  it('names the active worktree\'s branch, and disables Commit while conflicts remain', async () => {
    h.inProgress = merge(2);
    await show();
    expect(screen.getByText('Merging feature/x into main: 2 conflicted files.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Commit' })).toHaveAttribute('aria-disabled', 'true');
  });

  it('enables Commit once nothing is conflicted', async () => {
    h.inProgress = merge(0);
    await show();
    expect(screen.getByRole('button', { name: 'Commit' })).not.toHaveAttribute('aria-disabled');
  });

  it('rebase: Continue is gated, Skip and Abort are not', async () => {
    h.inProgress = { kind: 'rebase', onto: 'b'.repeat(40), headName: 'refs/heads/main', step: 1, total: 2, stoppedAt: null, conflicted: 1 };
    await show();
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(h.rebaseControl).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Skip' }));
    expect(h.rebaseControl).toHaveBeenCalledWith(1, '/r', 'skip');
  });

  it('Abort puts the pre-merge draft back', async () => {
    h.inProgress = merge(1);
    await show();
    await waitFor(() => expect(readWipDraft('/r', '/r').description).toBe("Merge branch 'feature/x'"));
    fireEvent.click(screen.getByRole('button', { name: 'Abort' }));
    await waitFor(() => expect(readWipDraft('/r', '/r')).toEqual({ summary: 'Mine', description: '' }));
    expect(h.mergeAbort).toHaveBeenCalledWith(1, '/r');
  });
});
