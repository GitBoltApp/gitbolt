import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

const editHeadMessage = vi.hoisted(() => vi.fn(async () => ({ outcome: { oid: 'new' }, journal: {}, staging: {}, wip: null })));
const headOnUpstream = vi.hoisted(() => vi.fn(async () => 'origin/main'));
vi.mock('../api/client', async (orig) => ({ ...(await orig<typeof import('../api/client')>()), api: { editHeadMessage, headOnUpstream } }));
vi.mock('../write/client', () => ({ runWrite: async (_ctx: unknown, send: () => Promise<{ outcome: unknown }>) => (await send()).outcome }));
vi.mock('../app/runtime', () => ({ useRuntime: { getState: () => ({ refresh: async () => {} }) } }));
vi.mock('../app/graphNav', () => ({ selectCommit: vi.fn() }));

import { HeadMessageEditor } from './HeadMessageEditor';

const ctx = { tabId: 't', repoId: 1, worktree: '/r' };

describe('edit the HEAD message (spec #2 §8.3)', () => {
  it('edits the message in the commit box’s two fields; Ctrl+Enter saves with the HEAD shown', async () => {
    const onDone = vi.fn();
    render(<HeadMessageEditor ctx={ctx} head="h1" message={{ summary: 'Fix x', body: '\r\nBody' }} onDone={onDone} />);
    const summary = screen.getByRole('textbox', { name: 'Commit summary' });
    expect(summary).toHaveValue('Fix x');
    expect(screen.getByRole('textbox', { name: 'Commit description' })).toHaveValue('Body');
    fireEvent.change(summary, { target: { value: 'Fix x properly' } });
    fireEvent.keyDown(summary, { key: 'Enter', ctrlKey: true });
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(editHeadMessage).toHaveBeenCalledWith(1, '/r', 'Fix x properly\n\nBody', { head: 'h1', refs: {} });
  });

  it('says when HEAD is already on its upstream; Esc cancels', async () => {
    const onDone = vi.fn();
    render(<HeadMessageEditor ctx={ctx} head="h1" message={{ summary: 'Fix x', body: '' }} onDone={onDone} />);
    expect(await screen.findByRole('note')).toHaveTextContent("This commit is on origin/main; you'll need to force push.");
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Commit summary' }), { key: 'Escape' });
    expect(onDone).toHaveBeenCalled();
    expect(editHeadMessage).not.toHaveBeenCalled();
  });
});
