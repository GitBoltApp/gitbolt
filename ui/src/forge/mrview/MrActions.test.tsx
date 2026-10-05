import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({ forgeApprove: vi.fn(async () => null), forgeRequestChanges: vi.fn(async () => null), forgeSetDraft: vi.fn(), forgeEditMr: vi.fn(), forgeLabels: vi.fn(async () => [{ name: 'ui', color: '#1f75cb', description: null }]) }));
vi.mock('../../api/client', () => ({ api, errorMessage: (e: unknown) => String((e as { message?: string })?.message ?? e) }));
const polling = vi.hoisted(() => ({ notifyForgeWrite: vi.fn() }));
vi.mock('../usePolling', () => polling);
const poll = vi.hoisted(() => ({ refreshMr: vi.fn(async () => {}) }));
vi.mock('../poll', () => poll);

const { MrActions } = await import('./MrActions');
const { forgeOf, patchForge, useForge } = await import('../mrStore');
const { useRuntime } = await import('../../app/runtime');
const { useToast } = await import('../../ui/toast');
const { useMenu } = await import('../../menu/menuStore');
const { ContextMenu } = await import('../../menu/ContextMenu');
const { detailOf, mrOf, user } = await import('../testMrs');

const mr = mrOf(12, { title: 'Dev work', labels: ['backend'] });
const detail = detailOf(mr);
const show = (m = mr, d = detail) => render(<><MrActions tabId="t" kind="gitlab" mr={m} detail={d}><button type="button">Check out</button></MrActions><ContextMenu /></>);
const menuRow = (label: string) => { fireEvent.click(screen.getByRole('button', { name: 'More actions' })); return screen.getByRole('menuitem', { name: new RegExp(label) }); };

beforeEach(() => {
  vi.clearAllMocks();
  useForge.setState({ byTab: {} });
  patchForge('t', { kind: 'gitlab', remote: 'origin', me: 'ada', details: { 12: { value: detail, at: 1 } } });
  useRuntime.setState({ tabs: { t: { repo: { id: 4 } } as never } });
  useToast.getState().dismiss();
  useMenu.getState().close();
});

describe("the MR/PR view's actions (spec #4 §4 \"4B\")", () => {
  it('Approve approves, says so, and has the poller reload (no second refresh of its own)', async () => {
    show();
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(useToast.getState().message).toBe('Approved !12'));
    expect(api.forgeApprove).toHaveBeenCalledWith(4, 12);
    expect(polling.notifyForgeWrite).toHaveBeenCalledTimes(1);
    expect(polling.notifyForgeWrite).toHaveBeenCalledWith('t');
    expect(poll.refreshMr).not.toHaveBeenCalled();
  });

  it('is "Approved" once you have', () => {
    const approved = detailOf({ ...mr, review: { decision: 'approved', approvals: 1, approvalsRequired: null, reviews: [{ user: user('Ada Lovelace'), state: 'approved', submittedAt: null }] } });
    show(mr, approved);
    expect(screen.getByRole('button', { name: 'Approved' })).toBeDisabled();
  });

  it('Request changes needs a comment, then sends it', async () => {
    show();
    fireEvent.click(screen.getByRole('button', { name: 'Request changes' }));
    const form = screen.getByRole('form', { name: 'Request changes' });
    const send = within(form).getByRole('button', { name: 'Request changes' });
    expect(send).toBeDisabled();
    fireEvent.change(within(form).getByRole('textbox', { name: 'What should change?' }), { target: { value: 'Please add a test.' } });
    fireEvent.click(send);
    await waitFor(() => expect(useToast.getState().message).toBe('Requested changes on !12'));
    expect(api.forgeRequestChanges).toHaveBeenCalledWith(4, 12, 'Please add a test.');
    expect(polling.notifyForgeWrite).toHaveBeenCalledTimes(1);
    expect(poll.refreshMr).not.toHaveBeenCalled();
    expect(screen.queryByRole('form', { name: 'Request changes' })).toBeNull();
  });

  it("Mark as ready / Mark as draft follow the state, and the server's answer is shown", async () => {
    api.forgeSetDraft.mockResolvedValueOnce(mrOf(12, { title: 'Dev work', state: 'open' }));
    show(mrOf(12, { state: 'draft' }));
    fireEvent.click(menuRow('Mark as ready'));
    await waitFor(() => expect(forgeOf('t').details[12]?.value.mr.state).toBe('open'));
    expect(api.forgeSetDraft).toHaveBeenCalledWith(4, 12, false);
  });

  it('Edit sends only what changed', async () => {
    api.forgeEditMr.mockResolvedValue(mrOf(12, { title: 'Dev work, part 1', labels: ['backend', 'ui'] }));
    show();
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    const form = screen.getByRole('form', { name: 'Edit' });
    const save = within(form).getByRole('button', { name: 'Save' });
    expect(save).toBeDisabled();
    fireEvent.change(within(form).getByRole('textbox', { name: 'Title' }), { target: { value: 'Dev work, part 1' } });
    // Labels come from the project's own labels: no free text.
    expect(within(form).queryByRole('textbox', { name: 'Labels' })).toBeNull();
    fireEvent.change(within(form).getByRole('combobox', { name: 'Labels' }), { target: { value: 'u' } });
    fireEvent.click(await within(form).findByRole('option', { name: /ui/ }));
    expect(api.forgeLabels).toHaveBeenCalledWith(4, 'origin', 'u');
    fireEvent.click(save);
    await waitFor(() => expect(api.forgeEditMr).toHaveBeenCalledWith(4, 12, { title: 'Dev work, part 1', description: null, labels: ['backend', 'ui'] }));
    await waitFor(() => expect(screen.queryByRole('form', { name: 'Edit' })).toBeNull());
    expect(forgeOf('t').details[12]?.value.mr.title).toBe('Dev work, part 1');
  });

  it('a failed edit says which MR it was', async () => {
    api.forgeEditMr.mockRejectedValueOnce({ message: 'gitlab.example.com refused: insufficient_scope' });
    show();
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    const form = screen.getByRole('form', { name: 'Edit' });
    fireEvent.change(within(form).getByRole('textbox', { name: 'Title' }), { target: { value: 'Dev work, part 1' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(useToast.getState().message).toBe("Couldn't edit !12: gitlab.example.com refused: insufficient_scope"));
  });

  it('a failed write says why and leaves the MR as it was', async () => {
    api.forgeApprove.mockRejectedValueOnce({ message: 'gitlab.example.com refused: insufficient_scope' });
    show();
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(useToast.getState().message).toBe("Couldn't approve !12: gitlab.example.com refused: insufficient_scope"));
    expect(polling.notifyForgeWrite).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Approve' })).toBeEnabled();
  });

  it('Approve is green-tinted and Request changes orange-tinted; Check out, Edit and the ⋯ menu sit on the right', () => {
    show();
    expect(screen.getByRole('button', { name: 'Approve' })).toHaveClass('approve');
    expect(screen.getByRole('button', { name: 'Request changes' })).toHaveClass('changes');
    const group = screen.getByRole('group', { name: 'Actions' });
    expect(within(group).getAllByRole('button').map((b) => b.getAttribute('aria-label') ?? b.textContent?.trim())).toEqual(['Approve', 'Request changes', 'Check out', 'Edit', 'More actions']);
  });

  it('the ⋯ menu holds Mark as draft and Copy link', () => {
    show();
    fireEvent.click(screen.getByRole('button', { name: 'More actions' }));
    expect(screen.getAllByRole('menuitem').map((r) => r.textContent)).toEqual([expect.stringContaining('Mark as draft'), expect.stringContaining('Copy link')]);
  });

  it('is disabled while a write runs', async () => {
    let done: (v: null) => void = () => {};
    api.forgeApprove.mockReturnValueOnce(new Promise((r) => { done = r; }));
    show();
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    expect(await screen.findByRole('button', { name: 'More actions' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Edit' })).toBeDisabled();
    done(null);
    await waitFor(() => expect(screen.getByRole('button', { name: 'More actions' })).toBeEnabled());
  });

  it('on a merged MR: no review actions or Edit, but Check out and the menu (Copy link only)', () => {
    show(mrOf(12, { state: 'merged' }));
    for (const n of ['Approve', 'Request changes', 'Edit']) expect(screen.queryByRole('button', { name: n })).toBeNull();
    expect(screen.getByRole('button', { name: 'Check out' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'More actions' }));
    expect(screen.getAllByRole('menuitem')).toHaveLength(1);
  });
});
