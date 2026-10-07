import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ForgeDiscussion } from '../../api/gen/ForgeDiscussion';

const api = vi.hoisted(() => ({ forgeReply: vi.fn(), forgeResolve: vi.fn() }));
vi.mock('../../api/client', () => ({ api, errorMessage: (e: unknown) => String((e as { message?: string })?.message ?? e) }));
vi.mock('../usePolling', () => ({ notifyForgeWrite: vi.fn() }));
vi.mock('./openNote', () => ({ openNoteFile: vi.fn() }));

const { ReplyBox } = await import('./ReplyBox');
const { Discussion } = await import('./Thread');
const { useReplyDrafts } = await import('./drafts');
const { forgeOf, patchForge, useForge } = await import('../mrStore');
const { useRuntime } = await import('../../app/runtime');
const { useToast } = await import('../../ui/toastStore');
const { mrOf, user } = await import('../testMrs');
const { preloadMarkdown } = await import('../../markdown/lazy');

// The Markdown chunk loaded before any test (test-setup does it too, but quietly): the preview then
// renders in the click's own update, with nothing to wait for.
beforeAll(() => preloadMarkdown(), 60_000);

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
    await waitFor(() => expect(useToast.getState().message).toBe("Couldn't comment on !12: gitlab.example.com rate limit reached: try again in 2 min"));
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

  describe('Reply and resolve', () => {
    const resolvable = (resolved: boolean): ForgeDiscussion => ({ ...thread('d1'), resolvable: true, resolved });
    const open = (d: ForgeDiscussion, kind: 'gitlab' | 'github' = 'gitlab') => {
      patchForge('t', { kind, discussions: { 12: [d] } });
      render(<Discussion tabId="t" kind={kind} mr={mrOf(12)} d={d} />);
      fireEvent.click(screen.getByRole('button', { name: 'Reply' }));
      fireEvent.change(screen.getByRole('textbox', { name: 'Reply' }), { target: { value: 'Done' } });
    };
    const stored = () => forgeOf('t').discussions[12]![0]!;

    it('an unresolved thread: replies, then resolves it', async () => {
      api.forgeReply.mockResolvedValue(note('Done'));
      api.forgeResolve.mockResolvedValue({ resolved: true, resolvedBy: 'Ada Lovelace' });
      open(resolvable(false));
      fireEvent.click(screen.getByRole('button', { name: 'Reply and resolve' }));
      await waitFor(() => expect(stored().resolved).toBe(true));
      expect(stored().notes.map((n) => n.body)).toEqual(['Why?', 'Done']);
      expect(api.forgeReply).toHaveBeenCalledWith(4, 12, 'd1', 'Done');
      expect(api.forgeResolve).toHaveBeenCalledWith(4, 12, 'd1', true);
      expect(api.forgeReply.mock.invocationCallOrder[0]).toBeLessThan(api.forgeResolve.mock.invocationCallOrder[0]!);
    });

    it('a resolved thread: Reply and unresolve (GitHub review threads too)', async () => {
      api.forgeReply.mockResolvedValue(note('Done'));
      api.forgeResolve.mockResolvedValue({ resolved: false, resolvedBy: null });
      open({ ...resolvable(true), id: 'thread-PRRT_1' }, 'github');
      expect(screen.queryByRole('button', { name: 'Reply and resolve' })).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: 'Reply and unresolve' }));
      await waitFor(() => expect(stored().resolved).toBe(false));
      expect(api.forgeResolve).toHaveBeenCalledWith(4, 12, 'thread-PRRT_1', false);
    });

    it('Ctrl+Shift+Enter replies and resolves; Ctrl+Enter only replies', async () => {
      api.forgeReply.mockResolvedValue(note('Done'));
      api.forgeResolve.mockResolvedValue({ resolved: true, resolvedBy: 'Ada Lovelace' });
      open(resolvable(false));
      fireEvent.keyDown(screen.getByRole('textbox', { name: 'Reply' }), { key: 'Enter', ctrlKey: true, shiftKey: true });
      await waitFor(() => expect(api.forgeResolve).toHaveBeenCalledWith(4, 12, 'd1', true));
      cleanup();
      vi.clearAllMocks();
      api.forgeReply.mockResolvedValue(note('Done'));
      open(resolvable(false));
      fireEvent.keyDown(screen.getByRole('textbox', { name: 'Reply' }), { key: 'Enter', ctrlKey: true });
      await waitFor(() => expect(api.forgeReply).toHaveBeenCalled());
      await waitFor(() => expect(stored().notes).toHaveLength(2));
      expect(api.forgeResolve).not.toHaveBeenCalled();
    });

    it('only where resolving is allowed: a thread that is not resolvable has just Reply', () => {
      open(thread('d1'));
      expect(screen.queryByRole('button', { name: /^Reply and/ })).toBeNull();
    });

    it('the resolve refused: the reply stays, the thread as it was, and a toast says so', async () => {
      api.forgeReply.mockResolvedValue(note('Done'));
      api.forgeResolve.mockRejectedValueOnce({ message: 'HTTP 403' });
      open(resolvable(false));
      fireEvent.click(screen.getByRole('button', { name: 'Reply and resolve' }));
      await waitFor(() => expect(useToast.getState().message).toBe("Replied, but couldn't resolve the thread: HTTP 403"));
      expect(stored().resolved).toBe(false);
      expect(stored().notes.map((n) => n.body)).toEqual(['Why?', 'Done']);
    });

    it('the reply refused: nothing is resolved', async () => {
      api.forgeReply.mockRejectedValueOnce({ message: 'HTTP 500' });
      open(resolvable(false));
      fireEvent.click(screen.getByRole('button', { name: 'Reply and resolve' }));
      await waitFor(() => expect(useToast.getState().message).toBe("Couldn't reply on !12: HTTP 500"));
      expect(api.forgeResolve).not.toHaveBeenCalled();
      expect(screen.getByRole('textbox', { name: 'Reply' })).toHaveValue('Done');
    });
  });

  it('previews the comment rendered before sending (spec #5 §3.2)', () => {
    render(<ReplyBox tabId="t" number={12} discussion={null} />);
    fireEvent.change(screen.getByRole('textbox', { name: 'Write a comment' }), { target: { value: '**Looks** good' } });
    fireEvent.click(screen.getByRole('tab', { name: 'Preview' }));
    expect(document.querySelector('.md-field-preview strong')).toHaveTextContent('Looks');
    expect(screen.getByRole('button', { name: 'Comment' })).toBeEnabled();
  });
});
