import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ForgeDiscussion } from '../../api/gen/ForgeDiscussion';

const api = vi.hoisted(() => ({ forgeReply: vi.fn() }));
vi.mock('../../api/client', () => ({ api, errorMessage: (e: unknown) => String((e as { message?: string })?.message ?? e) }));
vi.mock('../usePolling', () => ({ notifyForgeWrite: vi.fn() }));
vi.mock('./openNote', () => ({ openNoteFile: vi.fn() }));

const { ReplyBox } = await import('./ReplyBox');
const { Discussion } = await import('./Thread');
const { useReplyDrafts } = await import('./drafts');
const { forgeOf, patchForge, useForge } = await import('../mrStore');
const { useRuntime } = await import('../../app/runtime');
const { useToast } = await import('../../ui/toast');
const { mrOf, user } = await import('../testMrs');

const ada = user('Ada Lovelace');
const thread = (id: string): ForgeDiscussion => ({ id, resolvable: false, resolved: false, notes: [{ id: '1', author: user('Grace Hopper'), body: 'Why?', createdAt: 1, system: false, position: null }] });
const note = (body: string) => ({ id: '9', author: ada, body, createdAt: 2, system: false, position: null });

beforeEach(() => {
  vi.clearAllMocks();
  useForge.setState({ byTab: {} });
  useReplyDrafts.setState({ text: {} });
  patchForge('t', { kind: 'gitlab', discussions: { 12: [thread('d1')] } });
  useRuntime.setState({ tabs: { t: { repo: { id: 4 } } as never } });
  useToast.getState().dismiss();
});

describe('replying in the MR/PR view (spec #4 §4 "4B")', () => {
  it('a comment is sent, shown at once, and the box empties', async () => {
    api.forgeReply.mockResolvedValue(note('Thanks!'));
    render(<ReplyBox tabId="t" number={12} discussion={null} />);
    const box = screen.getByRole('textbox', { name: 'Write a comment' });
    expect(screen.getByRole('button', { name: 'Comment' })).toBeDisabled();
    fireEvent.change(box, { target: { value: 'Thanks!' } });
    fireEvent.click(screen.getByRole('button', { name: 'Comment' }));
    await waitFor(() => expect(forgeOf('t').discussions[12]?.at(-1)?.notes[0]?.body).toBe('Thanks!'));
    expect(api.forgeReply).toHaveBeenCalledWith(4, 12, null, 'Thanks!');
    expect(box).toHaveValue('');
  });

  it('Ctrl+Enter sends', async () => {
    api.forgeReply.mockResolvedValue(note('Quick one'));
    render(<ReplyBox tabId="t" number={12} discussion={null} />);
    const box = screen.getByRole('textbox', { name: 'Write a comment' });
    fireEvent.change(box, { target: { value: 'Quick one' } });
    fireEvent.keyDown(box, { key: 'Enter', ctrlKey: true });
    await waitFor(() => expect(api.forgeReply).toHaveBeenCalledWith(4, 12, null, 'Quick one'));
  });

  it('a reply draft survives closing and reopening the view', () => {
    const { unmount } = render(<ReplyBox tabId="t" number={12} discussion={null} />);
    fireEvent.change(screen.getByRole('textbox', { name: 'Write a comment' }), { target: { value: 'Half a thought' } });
    unmount();
    render(<ReplyBox tabId="t" number={12} discussion={null} />);
    expect(screen.getByRole('textbox', { name: 'Write a comment' })).toHaveValue('Half a thought');
  });

  it('a failed send keeps the text and says why', async () => {
    api.forgeReply.mockRejectedValueOnce({ message: 'gitlab.example.com rate limit reached: try again in 2 min' });
    render(<ReplyBox tabId="t" number={12} discussion={null} />);
    fireEvent.change(screen.getByRole('textbox', { name: 'Write a comment' }), { target: { value: 'Keep me' } });
    fireEvent.click(screen.getByRole('button', { name: 'Comment' }));
    await waitFor(() => expect(useToast.getState().message).toBe("Couldn't comment: gitlab.example.com rate limit reached: try again in 2 min"));
    expect(screen.getByRole('textbox', { name: 'Write a comment' })).toHaveValue('Keep me');
  });

  it('a GitLab thread takes a reply in place; a GitHub conversation comment has no thread', async () => {
    api.forgeReply.mockResolvedValue(note('Sure'));
    const { unmount } = render(<Discussion tabId="t" kind="gitlab" mr={mrOf(12)} d={thread('d1')} />);
    fireEvent.click(screen.getByRole('button', { name: 'Reply' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Reply' }), { target: { value: 'Sure' } });
    fireEvent.click(screen.getByRole('button', { name: 'Reply' }));
    await waitFor(() => expect(forgeOf('t').discussions[12]?.[0]?.notes.map((n) => n.body)).toEqual(['Why?', 'Sure']));
    expect(api.forgeReply).toHaveBeenCalledWith(4, 12, 'd1', 'Sure');
    unmount();
    render(<Discussion tabId="t" kind="github" mr={mrOf(12)} d={thread('issue-41')} />);
    expect(screen.queryByRole('button', { name: 'Reply' })).toBeNull();
  });
});
