import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FileChange } from '../api/gen/FileChange';

const stage = vi.hoisted(() => vi.fn(async () => true));
const unstage = vi.hoisted(() => vi.fn(async () => true));
const discard = vi.hoisted(() => vi.fn(async () => true));
vi.mock('./actions', async (orig) => ({ ...(await orig<typeof import('./actions')>()), stagePaths: stage, unstageFiles: unstage, discardPaths: discard }));
const confirm = vi.hoisted(() => vi.fn(async (_r: { arm: string }) => true));
vi.mock('../ui/ConfirmDialog', () => ({ confirmAction: confirm }));

import { RowActions } from './RowActions';
import { useStaging } from './store';

const ctx = { tabId: 't', repoId: 1, worktree: '/r' };
const f = (path: string, oldPath: string | null = null): FileChange => ({ path, oldPath, status: oldPath ? 'R' : 'M', additions: 1, deletions: 0, old: { kind: 'absent' }, new: { kind: 'worktree', worktree: '/r' }, submodule: false });

beforeEach(() => {
  stage.mockClear();
  unstage.mockClear();
  discard.mockClear();
  useStaging.setState({ states: {}, committing: {} });
});

describe('row actions (spec #2 §7.1)', () => {
  it('an unstaged row stages its file; a folder row stages every file under it', () => {
    render(<RowActions ctx={ctx} which="unstaged" files={[f('src/a.txt'), f('src/b.txt')]} name="src" />);
    fireEvent.click(screen.getByRole('button', { name: 'Stage src' }));
    expect(stage).toHaveBeenCalledWith(ctx, ['src/a.txt', 'src/b.txt']);
  });

  it('an unstaged row\'s Discard arms in place, then discards (board C); a submodule row has no Discard', async () => {
    render(<RowActions ctx={ctx} which="unstaged" files={[f('a.txt')]} name="a.txt" />);
    fireEvent.click(screen.getByRole('button', { name: 'Discard a.txt' }));
    expect(confirm.mock.calls[0][0]).toMatchObject({ arm: 'Click again to discard a.txt', danger: true });
    await vi.waitFor(() => expect(discard).toHaveBeenCalledWith(ctx, ['a.txt']));
    confirm.mockResolvedValueOnce(false);
    discard.mockClear();
    fireEvent.click(screen.getAllByRole('button', { name: 'Discard a.txt' })[0]);
    await Promise.resolve();
    expect(discard).not.toHaveBeenCalled();
    render(<RowActions ctx={ctx} which="unstaged" files={[{ ...f('sub'), submodule: true }]} name="sub" />);
    expect(screen.queryByRole('button', { name: 'Discard sub' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Stage sub' })).toBeInTheDocument();
  });

  it('a staged row unstages, renames with both paths', () => {
    const rename = f('new.txt', 'old.txt');
    render(<RowActions ctx={ctx} which="staged" files={[rename]} name="new.txt" />);
    fireEvent.click(screen.getByRole('button', { name: 'Unstage new.txt' }));
    expect(unstage).toHaveBeenCalledWith(ctx, [rename]);
  });

  it('is disabled while a commit for the worktree is queued or running ("Commit queued", §3.6)', async () => {
    useStaging.getState().setCommitting(1, '/r', true);
    render(<RowActions ctx={ctx} which="unstaged" files={[f('a.txt')]} name="a.txt" />);
    const b = screen.getByRole('button', { name: 'Stage a.txt' });
    expect(b).toHaveAttribute('aria-disabled', 'true');
    fireEvent.click(b);
    expect(stage).not.toHaveBeenCalled();
    fireEvent.mouseEnter(b);
    expect(await screen.findByRole('tooltip')).toHaveTextContent('Commit queued');
  });
});
