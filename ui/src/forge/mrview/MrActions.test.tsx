import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({ forgeApprove: vi.fn(async () => null), forgeRequestChanges: vi.fn(async () => null), forgeSetDraft: vi.fn(), forgeEditMr: vi.fn() }));
vi.mock('../../api/client', () => ({ api, errorMessage: (e: unknown) => String((e as { message?: string })?.message ?? e) }));
const polling = vi.hoisted(() => ({ notifyForgeWrite: vi.fn() }));
vi.mock('../usePolling', () => polling);
const poll = vi.hoisted(() => ({ refreshMr: vi.fn(async () => {}) }));
vi.mock('../poll', () => poll);

const { MrActions } = await import('./MrActions');
const { forgeOf, patchForge, useForge } = await import('../mrStore');
const { useRuntime } = await import('../../app/runtime');
const { useToast } = await import('../../ui/toast');
const { detailOf, mrOf, user } = await import('../testMrs');

const mr = mrOf(12, { title: 'Dev work', labels: ['backend'] });
const detail = detailOf(mr);
const show = (m = mr, d = detail) => render(<MrActions tabId="t" kind="gitlab" mr={m} detail={d} />);

beforeEach(() => {
  vi.clearAllMocks();
  useForge.setState({ byTab: {} });
  patchForge('t', { kind: 'gitlab', me: 'ada', details: { 12: { value: detail, at: 1 } } });
  useRuntime.setState({ tabs: { t: { repo: { id: 4 } } as never } });
  useToast.getState().dismiss();
});

describe("the MR/PR view's actions (spec #4 §4 \"4B\")", () => {
  it('Approve approves, says so, and reloads the MR', async () => {
    show();
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(useToast.getState().message).toBe('Approved !12'));
    expect(api.forgeApprove).toHaveBeenCalledWith(4, 12);
    expect(poll.refreshMr).toHaveBeenCalledWith('t', 12);
    expect(polling.notifyForgeWrite).toHaveBeenCalledWith('t');
  });

  it('is "You approved it" once you have', () => {
    const approved = detailOf({ ...mr, review: { decision: 'approved', approvals: 1, approvalsRequired: null, reviews: [{ user: user('Ada Lovelace'), state: 'approved', submittedAt: null }] } });
    show(mr, approved);
    expect(screen.getByRole('button', { name: 'You approved it' })).toBeDisabled();
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
    expect(screen.queryByRole('form', { name: 'Request changes' })).toBeNull();
  });

  it("Mark as ready / Mark as draft follow the state, and the server's answer is shown", async () => {
    api.forgeSetDraft.mockResolvedValueOnce(mrOf(12, { title: 'Dev work', state: 'open' }));
    show(mrOf(12, { state: 'draft' }));
    fireEvent.click(screen.getByRole('button', { name: 'Mark as ready' }));
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
    fireEvent.change(within(form).getByRole('textbox', { name: 'Labels' }), { target: { value: 'backend, ui' } });
    fireEvent.click(save);
    await waitFor(() => expect(api.forgeEditMr).toHaveBeenCalledWith(4, 12, { title: 'Dev work, part 1', description: null, labels: ['backend', 'ui'] }));
    await waitFor(() => expect(screen.queryByRole('form', { name: 'Edit' })).toBeNull());
    expect(forgeOf('t').details[12]?.value.mr.title).toBe('Dev work, part 1');
  });

  it('a failed write says why and leaves the MR as it was', async () => {
    api.forgeApprove.mockRejectedValueOnce({ message: 'gitlab.example.com refused: insufficient_scope' });
    show();
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(useToast.getState().message).toBe("Couldn't approve !12: gitlab.example.com refused: insufficient_scope"));
    expect(poll.refreshMr).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Approve' })).toBeEnabled();
  });

  it('has nothing to offer on a merged or closed MR', () => {
    const { container } = show(mrOf(12, { state: 'merged' }));
    expect(container).toBeEmptyDOMElement();
  });
});
