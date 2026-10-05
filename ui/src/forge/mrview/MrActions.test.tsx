import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ForgeKind } from '../../api/gen/ForgeKind';
import type { ForgeMr } from '../../api/gen/ForgeMr';
import type { ForgeMrDetail } from '../../api/gen/ForgeMrDetail';

const api = vi.hoisted(() => ({ forgeApprove: vi.fn(async () => null), forgeRequestChanges: vi.fn(async () => null), forgeSetDraft: vi.fn(), forgeEditMr: vi.fn(), forgeLabels: vi.fn(async () => [{ name: 'ui', color: '#1f75cb', description: null }]) }));
vi.mock('../../api/client', () => ({ api, errorMessage: (e: unknown) => String((e as { message?: string })?.message ?? e) }));
const polling = vi.hoisted(() => ({ notifyForgeWrite: vi.fn() }));
vi.mock('../usePolling', () => polling);
const poll = vi.hoisted(() => ({ refreshMr: vi.fn(async () => {}) }));
vi.mock('../poll', () => poll);

const { MrForms, ReviewButtons, StatusActions, useMrActions } = await import('./MrActions');
const { forgeOf, patchForge, useForge } = await import('../mrStore');
const { useRuntime } = await import('../../app/runtime');
const { useToast } = await import('../../ui/toast');
const { useMenu } = await import('../../menu/menuStore');
const { ContextMenu } = await import('../../menu/ContextMenu');
const { ArmLayer } = await import('../../ui/arm/ArmLayer');
const { ConfirmDialog } = await import('../../ui/ConfirmDialog');
const { disarm } = await import('../../ui/arm/store');
const { setOrigin } = await import('../../ui/arm/origin');
const { armClock, press } = await import('../../ui/arm/armTesting');
const { detailOf, mrOf, user } = await import('../testMrs');

/** The three places the actions live in the view: the APPROVALS box's buttons, the status line's,
 * and the forms under the header. */
function Actions({ kind, mr, detail }: { kind: ForgeKind; mr: ForgeMr; detail: ForgeMrDetail | null }) {
  const a = useMrActions('t', kind, mr, detail);
  return (
    <>
      <div data-testid="approvals"><ReviewButtons kind={kind} mr={mr} actions={a} /></div>
      <div data-testid="status"><StatusActions actions={a}><button type="button">Check out</button></StatusActions></div>
      <MrForms tabId="t" kind={kind} mr={mr} detail={detail} actions={a} />
    </>
  );
}

const mr = mrOf(12, { title: 'Dev work', labels: ['backend'] });
const detail = detailOf(mr);
const show = (m = mr, d = detail, kind: ForgeKind = 'gitlab') => render(<><Actions kind={kind} mr={m} detail={d} /><p>elsewhere</p><ContextMenu /><ArmLayer /><ConfirmDialog /></>);
const menuRow = (label: string) => { fireEvent.click(screen.getByRole('button', { name: 'More actions' })); return screen.getByRole('menuitem', { name: new RegExp(label) }); };
const overlay = () => document.querySelector<HTMLElement>('.arm-overlay');

let rects: ReturnType<typeof vi.spyOn>;
let clock: ReturnType<typeof armClock>;
/** Approve: the first click arms it, the second (past the settle guard) approves. */
const approve = () => {
  press(screen.getByRole('button', { name: 'Approve' }));
  clock.settle();
  press(overlay()!);
};

beforeEach(() => {
  vi.clearAllMocks();
  useForge.setState({ byTab: {} });
  patchForge('t', { kind: 'gitlab', remote: 'origin', me: 'ada', details: { 12: { value: detail, at: 1 } } });
  useRuntime.setState({ tabs: { t: { repo: { id: 4 } } as never } });
  useToast.getState().dismiss();
  useMenu.getState().close();
  clock = armClock();
  // jsdom does no layout: a rendered control reports one box, so it's "shown" and arms in place.
  rects = vi.spyOn(HTMLElement.prototype, 'getClientRects').mockImplementation(function (this: HTMLElement) {
    return (this.isConnected ? [new DOMRect(10, 10, 20, 20)] : []) as unknown as DOMRectList;
  });
});
afterEach(() => {
  act(() => disarm());
  setOrigin(null);
  rects.mockRestore();
  clock.restore();
});

describe("the MR/PR view's actions (spec #4 §4 \"4B\")", () => {
  it('Approve arms in place first, then approves on the second click, says so, and has the poller reload', async () => {
    show();
    press(screen.getByRole('button', { name: 'Approve' }));
    expect(overlay()).toHaveTextContent('Click again to approve');
    expect(overlay()).toHaveClass('tone-positive');
    expect(api.forgeApprove).not.toHaveBeenCalled();
    clock.settle();
    press(overlay()!);
    await waitFor(() => expect(useToast.getState().message).toBe('Approved !12'));
    expect(api.forgeApprove).toHaveBeenCalledWith(4, 12);
    expect(polling.notifyForgeWrite).toHaveBeenCalledTimes(1);
    expect(polling.notifyForgeWrite).toHaveBeenCalledWith('t');
    expect(poll.refreshMr).not.toHaveBeenCalled();
  });

  it('an armed Approve is cancelled by Esc or a click elsewhere', async () => {
    show();
    press(screen.getByRole('button', { name: 'Approve' }));
    expect(overlay()).not.toBeNull();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(overlay()).toBeNull();
    press(screen.getByRole('button', { name: 'Approve' }));
    expect(overlay()).not.toBeNull();
    fireEvent.pointerDown(screen.getByText('elsewhere'));
    expect(overlay()).toBeNull();
    await Promise.resolve();
    expect(api.forgeApprove).not.toHaveBeenCalled();
  });

  it('Approve and Request changes are small icon buttons in the APPROVALS box, with the forge wording in their tooltips', () => {
    show();
    const box = screen.getByTestId('approvals');
    const group = within(box).getByRole('group', { name: 'Review' });
    const [ok, changes] = within(group).getAllByRole('button');
    expect(ok).toHaveAccessibleName('Approve');
    expect(ok).toHaveClass('mr-review-btn', 'approve');
    expect(ok).toHaveTextContent('');
    expect(changes).toHaveAccessibleName('Request changes');
    expect(changes).toHaveClass('mr-review-btn', 'changes');
    fireEvent.mouseEnter(ok!);
    expect(screen.getByRole('tooltip')).toHaveTextContent('Approve !12');
    fireEvent.mouseLeave(ok!);
    fireEvent.mouseEnter(changes!);
    expect(screen.getByRole('tooltip')).toHaveTextContent('Request changes on !12');
  });

  it("a GitHub PR's tooltips say #12", () => {
    show(mr, detail, 'github');
    fireEvent.mouseEnter(screen.getByRole('button', { name: 'Approve' }));
    expect(screen.getByRole('tooltip')).toHaveTextContent('Approve #12');
  });

  it('is "Approved" once you have, and disabled', () => {
    const approved = detailOf({ ...mr, review: { decision: 'approved', approvals: 1, approvalsRequired: null, reviews: [{ user: user('Ada Lovelace'), state: 'approved', submittedAt: null }] } });
    show(mr, approved);
    const btn = screen.getByRole('button', { name: 'Approved' });
    expect(btn).toBeDisabled();
    fireEvent.mouseEnter(btn);
    expect(screen.getByRole('tooltip')).toHaveTextContent('You approved !12');
  });

  it('Request changes opens its composer (no arm), which needs a comment, then sends it', async () => {
    show();
    fireEvent.click(screen.getByRole('button', { name: 'Request changes' }));
    expect(overlay()).toBeNull();
    const form = screen.getByRole('form', { name: 'Request changes' });
    expect(form).toHaveTextContent("GitLab's API has no review state");
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

  it("Edit's description is a ten-row textarea", () => {
    show();
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    expect(screen.getByRole('textbox', { name: 'Description' })).toHaveAttribute('rows', '10');
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
    fireEvent.click(within(form).getByRole('button', { name: 'Add label' }));
    fireEvent.change(within(form).getByRole('combobox', { name: 'Labels' }), { target: { value: 'u' } });
    fireEvent.click(await within(form).findByRole('option', { name: /ui/ }));
    expect(api.forgeLabels).toHaveBeenCalledWith(4, 'origin', '');
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
    approve();
    await waitFor(() => expect(useToast.getState().message).toBe("Couldn't approve !12: gitlab.example.com refused: insufficient_scope"));
    expect(polling.notifyForgeWrite).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Approve' })).toBeEnabled();
  });

  it('Check out, Edit and the ⋯ menu are the status line group', () => {
    show();
    const group = within(screen.getByTestId('status')).getByRole('group', { name: 'Actions' });
    expect(within(group).getAllByRole('button').map((b) => b.getAttribute('aria-label') ?? b.textContent?.trim())).toEqual(['Check out', 'Edit', 'More actions']);
  });

  it('the ⋯ menu holds Mark as draft and Copy link', () => {
    show();
    fireEvent.click(screen.getByRole('button', { name: 'More actions' }));
    expect(screen.getAllByRole('menuitem').map((r) => r.textContent)).toEqual([expect.stringContaining('Mark as draft'), expect.stringContaining('Copy link')]);
  });

  it('is disabled while a write runs, with a spinner in the check\'s place', async () => {
    let done: (v: null) => void = () => {};
    api.forgeApprove.mockReturnValueOnce(new Promise((r) => { done = r; }));
    show();
    approve();
    await waitFor(() => expect(screen.getByRole('button', { name: 'More actions' })).toBeDisabled());
    expect(screen.getByRole('button', { name: 'Edit' })).toBeDisabled();
    const btn = screen.getByRole('button', { name: 'Approve' });
    expect(btn).toHaveAttribute('aria-busy', 'true');
    expect(btn.querySelector('.spin')).not.toBeNull();
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
