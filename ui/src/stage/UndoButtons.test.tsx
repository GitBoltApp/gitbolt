import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const undo = vi.hoisted(() => vi.fn(async () => true));
const redo = vi.hoisted(() => vi.fn(async () => true));
vi.mock('./actions', async (orig) => ({ ...(await orig<typeof import('./actions')>()), stagingUndo: undo, stagingRedo: redo, loadStaging: vi.fn() }));

import { StagingUndoButtons, stagingView } from './UndoButtons';
import { useStaging } from './store';

const ctx = { tabId: 't', repoId: 1, worktree: '/r' };

beforeEach(() => {
  undo.mockClear();
  useStaging.setState({ states: {}, committing: {} });
});

describe('staging Undo/Redo (spec #2 §7.6)', () => {
  it('tooltips name the step, or say why not', () => {
    expect(stagingView({ undo: 'stage a hunk in a.php', redo: null, off: null }, 'undo', false)).toEqual({ tooltip: 'Undo stage a hunk in a.php (Ctrl+Z)', disabled: false });
    expect(stagingView({ undo: null, redo: 'unstage 3 files', off: null }, 'redo', false)).toEqual({ tooltip: 'Redo unstage 3 files (Ctrl+Shift+Z)', disabled: false });
    expect(stagingView({ undo: null, redo: null, off: null }, 'undo', false)).toEqual({ tooltip: 'Nothing to undo in staging', disabled: true });
    expect(stagingView({ undo: 'x', redo: null, off: 'Staging undo is off while files are conflicted.' }, 'undo', false).tooltip).toBe('Staging undo is off while files are conflicted.');
    expect(stagingView({ undo: 'x', redo: null, off: null }, 'undo', true)).toEqual({ tooltip: 'Commit queued', disabled: true });
  });

  it('the button runs staging undo for its worktree', () => {
    useStaging.getState().set(1, '/r', { undo: 'stage a.txt', redo: null, off: null });
    render(<StagingUndoButtons ctx={ctx} />);
    fireEvent.click(screen.getByRole('button', { name: 'Undo staging' }));
    expect(undo).toHaveBeenCalledWith(ctx);
    expect(screen.getByRole('button', { name: 'Redo staging' })).toHaveAttribute('aria-disabled', 'true');
  });
});
