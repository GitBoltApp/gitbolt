import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

const editHeadMessage = vi.hoisted(() => vi.fn(async () => ({ outcome: { oid: 'new' }, journal: {}, staging: {}, wip: null })));
const headOnUpstream = vi.hoisted(() => vi.fn(async () => 'origin/main'));
const rewordCommit = vi.hoisted(() => vi.fn(async () => ({ outcome: { status: 'done', commits: 2, fastForward: false }, journal: {}, staging: {}, wip: null })));
vi.mock('../api/client', async (orig) => ({ ...(await orig<typeof import('../api/client')>()), api: { editHeadMessage, headOnUpstream, rewordCommit } }));
// runWrite's success path: the follow-ups are its onSuccess (fix 1 M3), as a Retry's would be.
vi.mock('../write/client', () => ({
  runWrite: async (_ctx: unknown, send: (confirmed: boolean, asked: { autostash: boolean }) => Promise<{ outcome: unknown }>, opts: { onSuccess?: (o: unknown) => Promise<void> } = {}) => {
    const out = (await send(false, { autostash: false })).outcome;
    await opts.onSuccess?.(out);
    return out;
  },
}));
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

  it('an older commit: Save rewords it in place through an interactive rebase (spec #3 §3.6)', async () => {
    render(<HeadMessageEditor ctx={{ tabId: 't', repoId: 1, worktree: '/r' }} head="c1" older={{ head: 'h1' }} message={{ summary: 'Fix x', body: '' }} onDone={() => {}} />);
    fireEvent.change(screen.getByRole('textbox', { name: 'Commit summary' }), { target: { value: 'Fix x properly' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    // 3C T13 ruling: the clean-restore question's answer goes through, as interactiveRebase's.
    await waitFor(() => expect(rewordCommit).toHaveBeenCalledWith(1, '/r', 'c1', 'Fix x properly', { head: 'h1', refs: {} }, false));
    expect(editHeadMessage).not.toHaveBeenCalled();
    expect(screen.getByRole('note', { name: 'Reword note' }).textContent).toContain('rebases the commits above it');
  });

  it('an older commit reworded: its new oid is selected, not the old one (3C final fix M4)', async () => {
    const { selectCommit } = await import('../app/graphNav');
    rewordCommit.mockResolvedValueOnce({ outcome: { status: 'done', commits: 2, fastForward: false, rewritten: 'c1new' } as never, journal: {}, staging: {}, wip: null });
    render(<HeadMessageEditor ctx={ctx} head="c1" older={{ head: 'h1' }} message={{ summary: 'Fix x', body: '' }} onDone={() => {}} />);
    fireEvent.change(screen.getByRole('textbox', { name: 'Commit summary' }), { target: { value: 'Fix x properly' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(selectCommit).toHaveBeenCalledWith('t', 'c1new'));
  });

  it('an older commit already pushed: the force-push note, though HEAD is not on its upstream (fix 1 M6)', async () => {
    headOnUpstream.mockResolvedValueOnce(null as unknown as string);
    const onDone = vi.fn();
    render(<HeadMessageEditor ctx={ctx} head="c1" older={{ head: 'h1', pushed: 'origin/feature' }} message={{ summary: 'Fix x', body: '' }} onDone={onDone} />);
    expect(screen.getByText("This commit is on origin/feature; you'll need to force push.")).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(onDone).toHaveBeenCalled());
  });
});
