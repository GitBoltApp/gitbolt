import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NonTextConflict } from './NonTextConflict';

const resolve = vi.fn(async (..._a: unknown[]) => true);
vi.mock('./resolve', () => ({ resolveFile: (...a: unknown[]) => resolve(...a) }));

const file = (kind: string) => ({ path: 'gone.txt', kind, text: false, segments: [], current: null, incoming: null, labels: { current: 'main', incoming: 'feature/x' }, encoding: 'UTF-8', eol: 'lf', base: 'x' }) as never;
const ctx = { tabId: 't', repoId: 1, worktree: '/r' };

describe('non-text conflicts (spec #2 §13.3)', () => {
  beforeEach(() => {
    resolve.mockReset();
    resolve.mockImplementation(async () => true);
  });

  it('names what each side did, and resolves by button, with the base it read', async () => {
    const onResolved = vi.fn();
    render(<NonTextConflict ctx={ctx} file={file('deletedByUs')} onResolved={onResolved} />);
    expect(screen.getByText('Deleted in main, modified in feature/x')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Take incoming' }));
    expect(resolve).toHaveBeenCalledWith(ctx, 'gone.txt', { kind: 'incoming' }, 'x', undefined);
    await waitFor(() => expect(onResolved).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Take current' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Take current' }));
    expect(resolve).toHaveBeenLastCalledWith(ctx, 'gone.txt', { kind: 'current' }, 'x', undefined);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Delete file' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Delete file' }));
    expect(resolve).toHaveBeenLastCalledWith(ctx, 'gone.txt', { kind: 'delete' }, 'x', undefined);
  });

  it('a refused or declined resolution leaves the conflict open', async () => {
    resolve.mockResolvedValueOnce(false);
    const onResolved = vi.fn();
    render(<NonTextConflict ctx={ctx} file={file('bothModified')} onResolved={onResolved} />);
    expect(screen.getByText('Changed in both main and feature/x (not text)')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Take current' }));
    await waitFor(() => expect(resolve).toHaveBeenLastCalledWith(ctx, 'gone.txt', { kind: 'current' }, 'x', undefined));
    expect(onResolved).not.toHaveBeenCalled();
  });

  it('one send at a time: the buttons wait for the answer (M11)', async () => {
    let answer: (ok: boolean) => void = () => {};
    resolve.mockImplementationOnce(() => new Promise<boolean>((r) => { answer = r; }));
    render(<NonTextConflict ctx={ctx} file={file('bothModified')} />);
    fireEvent.click(screen.getByRole('button', { name: 'Take current' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Take incoming' })).toBeDisabled());
    fireEvent.click(screen.getByRole('button', { name: 'Take current' }));
    expect(resolve).toHaveBeenCalledTimes(1);
    await act(async () => answer(true));
    expect(screen.getByRole('button', { name: 'Take incoming' })).toBeEnabled();
  });

  it('a Stale answer goes to onStale (the tool re-reads the conflict), not a dead-end Retry', async () => {
    resolve.mockImplementationOnce(async (...a: unknown[]) => {
      const handle = a[4] as (e: { kind: string; message: string }) => boolean;
      expect(handle({ kind: 'Other', message: 'x' })).toBe(false);
      expect(handle({ kind: 'Stale', message: "gone.txt isn't conflicted anymore" })).toBe(true);
      return false;
    });
    const onStale = vi.fn();
    render(<NonTextConflict ctx={ctx} file={file('bothModified')} onStale={onStale} />);
    fireEvent.click(screen.getByRole('button', { name: 'Take current' }));
    await waitFor(() => expect(onStale).toHaveBeenCalledWith("gone.txt isn't conflicted anymore"));
  });
});
