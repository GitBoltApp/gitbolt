import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { api } from '../api/client';
import { useRuntime } from '../app/runtime';
import * as active from './active';
import { CreateWorktreeDialog, openCreateWorktree } from './CreateWorktreeDialog';

const res = (outcome: unknown) => ({ outcome, journal: { undo: null, redo: null, undoBlocked: null, redoBlocked: null, banners: [] }, staging: { undo: null, redo: null, off: null }, wip: null });

describe('Create worktree (spec #2 §11.1)', () => {
  it('suggests the dash-joined folder, creates, and opens a new tab by default', async () => {
    useRuntime.getState().patch('t', { repo: { id: 1, path: '/r/shop', name: 'shop', worktree: '/r/shop' }, worktree: '/r/shop', sidebar: { locals: [], remotes: [], worktrees: [], stashes: [], tags: [] } as never });
    vi.spyOn(api, 'suggestWorktreePath').mockResolvedValue('/r/shop-feature-x');
    const add = vi.spyOn(api, 'worktreeAdd').mockResolvedValue(res({ path: '/r/shop-feature-x' }) as never);
    const tab = vi.spyOn(active, 'openWorktreeTab').mockResolvedValue();
    render(<CreateWorktreeDialog />);
    act(() => openCreateWorktree({ tabId: 't', at: 'a'.repeat(40), branch: null }));
    fireEvent.change(screen.getByRole('textbox', { name: 'New branch' }), { target: { value: 'feature/x' } });
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Folder' })).toHaveValue('/r/shop-feature-x'));
    expect(screen.getByRole('checkbox', { name: 'Open in a new tab' })).toBeChecked();
    fireEvent.click(screen.getByRole('button', { name: 'Create worktree' }));
    await waitFor(() => expect(add).toHaveBeenCalledWith(1, '/r/shop', '/r/shop-feature-x', { kind: 'new', name: 'feature/x', at: 'a'.repeat(40) }));
    await waitFor(() => expect(tab).toHaveBeenCalledWith('t', '/r/shop-feature-x'));
  });
});
