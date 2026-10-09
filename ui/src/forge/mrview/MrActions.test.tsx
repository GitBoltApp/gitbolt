import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ForgeKind } from '../../api/gen/ForgeKind';
import type { ForgeMr } from '../../api/gen/ForgeMr';
import type { ForgeMrDetail } from '../../api/gen/ForgeMrDetail';
import type { ReviewDraft } from '../../api/gen/ReviewDraft';
import type { ReviewSession } from '../mrStore';

const api = vi.hoisted(() => ({ forgeApprove: vi.fn(async () => null), forgeReview: vi.fn(async () => ({ fallback: false })), forgeSetDraft: vi.fn(), forgePeopleLimits: vi.fn(() => new Promise(() => {})), forgeSearchUsers: vi.fn(async () => []), forgeEditMr: vi.fn(), forgeSetSubscribed: vi.fn(async (_r: number, _n: number, on: boolean) => on), forgeLabels: vi.fn(async () => [{ name: 'ui', color: '#1f75cb', description: null }]) }));
vi.mock('../../api/client', () => ({ api, errorMessage: (e: unknown) => String((e as { message?: string })?.message ?? e) }));
const polling = vi.hoisted(() => ({ notifyForgeWrite: vi.fn() }));
vi.mock('../usePolling', () => polling);
const poll = vi.hoisted(() => ({ refreshMr: vi.fn(async () => {}) }));
vi.mock('../poll', () => poll);
const review = vi.hoisted(() => ({ session: null as null | ReviewSession, submitReview: vi.fn(), resumeReview: vi.fn(async () => {}), discardReview: vi.fn(async () => ({ ok: true, value: 0 })) }));
vi.mock('../review/session', async (orig) => {
  const { placeReview } = await import('../review/model');
  return {
    ...(await orig<typeof import('../review/session')>()),
    useReview: () => review.session,
    useReviewPlacements: () => (review.session ? placeReview(review.session, []) : null),
    submitReview: review.submitReview,
    resumeReview: review.resumeReview,
    discardReview: review.discardReview,
  };
});
const note = vi.hoisted(() => ({ openNoteFile: vi.fn(async () => {}) }));
vi.mock('./openNote', () => note);
/** A review pending on !12: drafts on no line (`pendingOf`), or as given. */
const pendingOf = (ids: string[], drafts: ReviewDraft[] = ids.map((id) => ({ id, body: `Draft ${id}`, position: null, replyTo: null }))): ReviewSession => ({
  number: 12, kind: 'gitlab', compare: null, refs: null, files: {}, diffHead: null, drafts, pendingReview: null, canDraft: true, closed: false, error: null, loaded: true,
});

const { MrForms, partialText, ReviewButtons, reviewSaid, StatusActions, useMrActions } = await import('./MrActions');
const { forgeOf, patchForge, useForge } = await import('../mrStore');
const { useRuntime } = await import('../../app/runtime');
const { useToast } = await import('../../ui/toastStore');
const { useMenu } = await import('../../menu/menuStore');
const { ContextMenu } = await import('../../menu/ContextMenu');
const { ArmLayer } = await import('../../ui/arm/ArmLayer');
const { ConfirmDialog } = await import('../../ui/ConfirmDialog');
const { disarm } = await import('../../ui/arm/store');
const { setOrigin } = await import('../../ui/arm/origin');
const { armClock, press } = await import('../../ui/arm/armTesting');
const { detailOf, mrOf, user } = await import('../testMrs');
const { useReplyDrafts } = await import('./drafts');

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
  review.session = null;
  useReplyDrafts.setState({ text: {} });
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

  it('Approve and Review… are small bordered buttons in the APPROVALS card, with the forge wording in their tooltips', () => {
    show();
    const box = screen.getByTestId('approvals');
    const group = within(box).getByRole('group', { name: 'Review' });
    const [ok, changes] = within(group).getAllByRole('button');
    expect(ok).toHaveAccessibleName('Approve');
    expect(ok).toHaveClass('card-btn', 'approve');
    expect(ok).toHaveTextContent('');
    expect(changes).toHaveAccessibleName('Review…');
    expect(changes).toHaveClass('card-btn', 'changes', 'prompts');
    // It opens the composer: a caret right of its icon; Approve acts: none.
    expect(changes!.querySelector('.card-caret')).toBeTruthy();
    expect(ok!.querySelector('.card-caret')).toBeNull();
    fireEvent.mouseEnter(ok!);
    expect(screen.getByRole('tooltip')).toHaveTextContent('Approve !12');
    fireEvent.mouseLeave(ok!);
    fireEvent.mouseEnter(changes!);
    expect(screen.getByRole('tooltip')).toHaveTextContent('Review !12: comment, approve or request changes');
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
    expect(btn, 'drawn pressed, in green').toHaveAttribute('data-on');
    fireEvent.mouseEnter(btn);
    expect(screen.getByRole('tooltip')).toHaveTextContent('You approved !12');
  });

  // --- MR round 2: the review composer ---
  const openReview = () => {
    fireEvent.click(screen.getByRole('button', { name: 'Review…' }));
    expect(overlay(), 'a prompt: no arm').toBeNull();
    return screen.getByRole('form', { name: 'Review' });
  };
  const mode = (form: HTMLElement, name: string) => fireEvent.click(within(form).getByRole('radio', { name }));
  const message = (form: HTMLElement, value: string) => fireEvent.change(within(form).getByRole('textbox', { name: 'Message' }), { target: { value } });

  it('Review… opens the composer: Comment, Approve and Request changes; the submit names the mode', () => {
    show();
    const form = openReview();
    expect(within(form).getAllByRole('radio').map((r) => r.closest('label')?.textContent)).toEqual(['Comment', 'Approve', 'Request changes']);
    expect(within(form).getByRole('radio', { name: 'Comment' })).toBeChecked();
    expect(within(form).getByRole('textbox', { name: 'Message' })).toHaveFocus();
    for (const name of ['Comment', 'Approve', 'Request changes']) {
      mode(form, name);
      expect(within(form).getByRole('button', { name })).toHaveAttribute('type', 'submit');
    }
  });

  it('Request changes needs a message, then sends it; GitLab says what it does', async () => {
    show();
    const form = openReview();
    mode(form, 'Request changes');
    expect(form).toHaveTextContent('withdraws your approval');
    const send = within(form).getByRole('button', { name: 'Request changes' });
    expect(send).toBeDisabled();
    message(form, 'Please add a test.');
    fireEvent.click(send);
    await waitFor(() => expect(useToast.getState().message).toBe('Requested changes on !12'));
    expect(api.forgeReview).toHaveBeenCalledWith(4, 12, { event: 'requestChanges', body: 'Please add a test.' });
    expect(polling.notifyForgeWrite).toHaveBeenCalledTimes(1);
    expect(poll.refreshMr).not.toHaveBeenCalled();
    expect(screen.queryByRole('form', { name: 'Review' })).toBeNull();
  });

  it('Approve needs no message; Comment needs one; Ctrl+Enter submits', async () => {
    show();
    let form = openReview();
    mode(form, 'Approve');
    fireEvent.click(within(form).getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(useToast.getState().message).toBe('Approved !12'));
    expect(api.forgeReview).toHaveBeenCalledWith(4, 12, { event: 'approve', body: '' });
    form = openReview();
    expect(within(form).getByRole('button', { name: 'Comment' })).toBeDisabled();
    message(form, 'Looks good');
    fireEvent.keyDown(within(form).getByRole('textbox', { name: 'Message' }), { key: 'Enter', ctrlKey: true });
    await waitFor(() => expect(useToast.getState().message).toBe('Commented on !12'));
    expect(api.forgeReview).toHaveBeenLastCalledWith(4, 12, { event: 'comment', body: 'Looks good' });
  });

  it("an older GitLab's Request changes: the toast says it only commented and withdrew the approval", async () => {
    api.forgeReview.mockResolvedValueOnce({ fallback: true });
    show();
    const form = openReview();
    mode(form, 'Request changes');
    message(form, 'Rename it');
    fireEvent.click(within(form).getByRole('button', { name: 'Request changes' }));
    await waitFor(() => expect(useToast.getState().message).toBe('Commented on !12. This GitLab has no Changes requested state, so your approval was withdrawn instead.'));
  });

  it('GitHub: no GitLab note', () => {
    show(mr, detail, 'github');
    const form = openReview();
    mode(form, 'Request changes');
    expect(form).not.toHaveTextContent('withdraws your approval');
  });

  it("opening the composer picks up a review left pending outside the session (a restart, the web page)", () => {
    show();
    fireEvent.click(screen.getByRole('button', { name: 'Review…' }));
    expect(review.resumeReview).toHaveBeenCalledWith('t', 12);
  });

  it('with a review pending, the composer sends the pending comments with it, a message optional', async () => {
    review.session = pendingOf(['5', '6']);
    // Sent: nothing is pending any more.
    review.submitReview.mockImplementationOnce(async () => { review.session = null; return { ok: true, value: { published: 2, eventError: null, bodyPosted: false, eventSent: false, fallback: false } }; });
    show();
    fireEvent.click(screen.getByRole('button', { name: 'Review…' }));
    const form = screen.getByRole('form', { name: 'Review' });
    expect(form).toHaveTextContent('Sends your 2 pending comments with it');
    fireEvent.click(within(form).getByRole('button', { name: 'Comment' }));
    await waitFor(() => expect(form).not.toBeInTheDocument());
    expect(review.submitReview).toHaveBeenCalledWith('t', { event: 'comment', body: '' });
    expect(api.forgeReview).not.toHaveBeenCalled();
    expect(useToast.getState().message).toBe('Sent your review of !12 with 2 comments');
  });

  it('when the forge takes the comments but refuses the approval, it stays open and says what went through', async () => {
    review.session = pendingOf(['5']);
    review.submitReview.mockResolvedValueOnce({ ok: true, value: { published: 1, eventError: 'gitlab.example.com refused: 403 Forbidden', bodyPosted: false, eventSent: false, fallback: false } });
    show();
    fireEvent.click(screen.getByRole('button', { name: 'Review…' }));
    const form = screen.getByRole('form', { name: 'Review' });
    fireEvent.click(within(form).getByRole('radio', { name: 'Approve' }));
    fireEvent.change(within(form).getByRole('textbox', { name: 'Message' }), { target: { value: 'Nice.' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Approve' }));
    expect(await within(form).findByRole('alert')).toHaveTextContent('Your comment was published, but GitLab refused the rest: gitlab.example.com refused: 403 Forbidden');
    expect(within(form).getByRole('textbox', { name: 'Message' })).toHaveValue('Nice.');
  });

  it("a part-way review says what's known: the comments went in, the forge refused the rest", () => {
    expect(partialText('gitlab', 2, 'gitlab.example.com refused: 403 Forbidden')).toBe('Your 2 comments were published, but GitLab refused the rest: gitlab.example.com refused: 403 Forbidden');
    expect(partialText('gitlab', 0, 'x')).toBe('Your pending review was published, but GitLab refused the rest: x');
  });

  it('a review sent with its pending comments says so in plain sentences', () => {
    expect(reviewSaid('requestChanges', '!12', true, 2)).toBe('Published 2 comments and commented on !12. This GitLab has no Changes requested state, so your approval was withdrawn instead.');
    expect(reviewSaid('requestChanges', '!12', false, 1)).toBe('Published 1 comment and requested changes on !12');
    expect(reviewSaid('approve', '!12', false, 2)).toBe('Published 2 comments and approved !12');
    expect(reviewSaid('approve', '!12', false, null)).toBe('Approved !12');
    // GitHub's pending review with no comment: nothing to count.
    expect(reviewSaid('comment', '#12', false, 0)).toBe('Commented on #12');
  });

  it('a part-way review keeps the composer even once nothing is pending (the panel goes)', async () => {
    review.session = pendingOf(['5']);
    review.submitReview.mockImplementationOnce(async () => { review.session = null; return { ok: true, value: { published: 1, eventError: 'gitlab.example.com refused: 403 Forbidden', bodyPosted: false, eventSent: false, fallback: false } }; });
    show();
    const form = screen.getByRole('form', { name: 'Review' });
    fireEvent.click(within(form).getByRole('radio', { name: 'Approve' }));
    fireEvent.click(within(form).getByRole('button', { name: 'Approve' }));
    expect(await within(form).findByRole('alert')).toHaveTextContent('Your comment was published, but GitLab refused the rest');
    expect(form).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: /Your review/ })).toBeNull();
  });

  it("a part-way review that answers once the composer is closed (Edit opened) says so in a toast", async () => {
    review.session = pendingOf(['5']);
    let answer!: (v: unknown) => void;
    review.submitReview.mockReturnValueOnce(new Promise((r) => { answer = r; }));
    const toast = vi.spyOn(useToast.getState(), 'show');
    show();
    const form = screen.getByRole('form', { name: 'Review' });
    fireEvent.click(within(form).getByRole('radio', { name: 'Approve' }));
    fireEvent.click(within(form).getByRole('button', { name: 'Approve' }));
    expect(form).toHaveAttribute('aria-busy', 'true');
    fireEvent.click(within(screen.getByTestId('status')).getByRole('button', { name: 'Edit' }));
    expect(form).not.toBeInTheDocument();
    await act(async () => answer({ ok: true, value: { published: 1, eventError: 'gitlab.example.com refused: 403 Forbidden', bodyPosted: false, eventSent: false, fallback: false } }));
    expect(toast).toHaveBeenCalledWith('Your comment was published, but GitLab refused the rest: gitlab.example.com refused: 403 Forbidden', { error: true });
    toast.mockRestore();
  });

  it('a message is kept until sent: closing the composer keeps it, Cancel drops it', () => {
    show();
    fireEvent.click(screen.getByRole('button', { name: 'Review…' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Message' }), { target: { value: 'Half a thought' } });
    fireEvent.click(screen.getByRole('button', { name: 'Review…' }));
    fireEvent.click(screen.getByRole('button', { name: 'Review…' }));
    expect(screen.getByRole('textbox', { name: 'Message' })).toHaveValue('Half a thought');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    fireEvent.click(screen.getByRole('button', { name: 'Review…' }));
    expect(screen.getByRole('textbox', { name: 'Message' })).toHaveValue('');
  });
  // --- end MR round 2 ---

  it("Mark as ready / Mark as draft follow the state, and the server's answer is shown", async () => {
    api.forgeSetDraft.mockResolvedValueOnce(mrOf(12, { title: 'Dev work', state: 'open' }));
    show(mrOf(12, { state: 'draft' }));
    fireEvent.click(menuRow('Mark as ready'));
    await waitFor(() => expect(forgeOf('t').details[12]?.value.mr.state).toBe('open'));
    expect(api.forgeSetDraft).toHaveBeenCalledWith(4, 12, false);
  });

  // --- MR round 2: notifications ---
  /** `Actions`, fed from the store (the menu's row follows the detail's `subscribed`). */
  const showLive = (subscribed: boolean | undefined) => {
    patchForge('t', { details: { 12: { value: { ...detail, subscribed }, at: 1 } } });
    const Live = () => {
      const d = useForge((s) => s.byTab.t?.details[12]?.value ?? null);
      return <Actions kind="gitlab" mr={mr} detail={d} />;
    };
    return render(<><Live /><ContextMenu /></>);
  };
  const subscribed = () => forgeOf('t').details[12]?.value.subscribed;

  it("⋯ Subscribe / Unsubscribe follows the forge's notifications, at once, and sends it", async () => {
    let answer!: (on: boolean) => void;
    api.forgeSetSubscribed.mockReturnValueOnce(new Promise((r) => { answer = r; }));
    showLive(false);
    fireEvent.click(menuRow('Subscribe'));
    expect(subscribed(), 'optimistic').toBe(true);
    await waitFor(() => expect(api.forgeSetSubscribed).toHaveBeenCalledWith(4, 12, true));
    answer(true);
    await waitFor(() => expect(polling.notifyForgeWrite).toHaveBeenCalled());
    fireEvent.click(menuRow('Unsubscribe'));
    await waitFor(() => expect(api.forgeSetSubscribed).toHaveBeenLastCalledWith(4, 12, false));
    await waitFor(() => expect(subscribed()).toBe(false));
  });

  it('a refused Subscribe is put back and says why; unknown: no row', async () => {
    api.forgeSetSubscribed.mockRejectedValueOnce({ message: 'gitlab.example.com refused: 403 Forbidden' });
    const { unmount } = showLive(false);
    fireEvent.click(menuRow('Subscribe'));
    await waitFor(() => expect(useToast.getState().message).toBe("Couldn't subscribe to !12: gitlab.example.com refused: 403 Forbidden"));
    expect(subscribed()).toBe(false);
    unmount();
    showLive(undefined);
    fireEvent.click(screen.getByRole('button', { name: 'More actions' }));
    expect(screen.queryByRole('menuitem', { name: /Subscribe/ })).toBeNull();
  });
  // --- end MR round 2 ---

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
    for (const n of ['Approve', 'Review…', 'Edit']) expect(screen.queryByRole('button', { name: n })).toBeNull();
    expect(screen.getByRole('button', { name: 'Check out' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'More actions' }));
    expect(screen.getAllByRole('menuitem')).toHaveLength(1);
  });
});

describe('your pending review in the MR/PR view (review comments round 2)', () => {
  const at = (path: string, line: number) => ({ path, oldPath: null, line, oldLine: null, snippet: null, startLine: null, startOldLine: null });
  const DRAFTS: ReviewDraft[] = [
    { id: '7', body: 'Rename this\n\nIt reads better.', position: at('src/z.rs', 30), replyTo: null },
    { id: '5', body: 'Off by one?', position: at('src/a.rs', 12), replyTo: null },
    { id: '6', body: 'A reply made on the web', position: null, replyTo: 'd9' },
  ];
  const panel = () => screen.getByRole('region', { name: /^Your (pending )?review/ });

  it('is open with a review pending, without Review…: its header counts, its rows say where and what, the loose one is a card, then the composer', () => {
    review.session = pendingOf([], DRAFTS);
    show();
    expect(panel()).toHaveTextContent('Your review · 3 pending');
    const rows = within(within(panel()).getByRole('list', { name: 'Pending comments' })).getAllByRole('listitem');
    // By file, then line.
    expect(rows.map((r) => r.textContent)).toEqual(['src/a.rs:12Off by one?', 'src/z.rs:30Rename this']);
    expect(within(within(panel()).getByRole('group', { name: 'Pending comments' })).getByText('A reply made on the web')).toBeInTheDocument();
    const form = within(panel()).getByRole('form', { name: 'Review' });
    expect(form).toHaveTextContent('Sends your 3 pending comments with it');
    // Open by default, but it doesn't take the keyboard as the view opens.
    expect(within(form).getByRole('textbox', { name: 'Message' })).not.toHaveFocus();
    // Its Cancel only clears a message: off while there's none.
    expect(within(form).getByRole('button', { name: 'Cancel' })).toBeDisabled();
  });

  it("a row's file:line opens the file at that line", () => {
    review.session = pendingOf([], DRAFTS);
    show();
    fireEvent.click(within(panel()).getByRole('button', { name: 'src/a.rs:12' }));
    expect(note.openNoteFile).toHaveBeenCalledWith('t', 'gitlab', expect.objectContaining({ number: 12 }), expect.objectContaining({ path: 'src/a.rs', line: 12 }));
  });

  it('none pending: no panel; Review… opens the composer as before', () => {
    show();
    expect(screen.queryByRole('region', { name: /Your review/ })).toBeNull();
    expect(screen.queryByRole('form', { name: 'Review' })).toBeNull();
    // A review on another MR/PR isn't this one's.
    review.session = { ...pendingOf(['5']), number: 13 };
    show();
    expect(screen.queryByRole('region', { name: /Your review/ })).toBeNull();
  });

  it('GitHub: a pending review with no comment yet is still a panel', () => {
    review.session = { ...pendingOf([]), kind: 'github', pendingReview: 'PRR_1' };
    show(mr, detail, 'github');
    expect(panel()).toHaveTextContent('Your pending review');
    expect(within(panel()).queryByRole('list')).toBeNull();
    expect(screen.getByRole('button', { name: 'Review…' })).toHaveAttribute('aria-expanded', 'true');
  });

  it('Review… takes the keyboard to the panel; the APPROVALS card has no other control for it', () => {
    review.session = pendingOf([], DRAFTS);
    show();
    // Approve and Review… only: the panel under the header is the cue.
    expect(within(screen.getByTestId('approvals')).getAllByRole('button').map((b) => b.getAttribute('aria-label'))).toEqual(['Approve', 'Review…']);
    const textbox = within(panel()).getByRole('textbox', { name: 'Message' });
    const reviewBtn = screen.getByRole('button', { name: 'Review…' });
    expect(reviewBtn).toHaveAttribute('aria-expanded', 'true');
    fireEvent.click(reviewBtn);
    expect(textbox).toHaveFocus();
    textbox.blur();
    fireEvent.click(reviewBtn);
    // Still there, and focused: Review… doesn't close it while a review is pending.
    expect(within(panel()).getByRole('textbox', { name: 'Message' })).toHaveFocus();
  });

  it('Discard arms in place, then deletes the pending review on the forge', async () => {
    review.session = pendingOf([], DRAFTS);
    show();
    press(within(panel()).getByRole('button', { name: 'Discard' }));
    expect(overlay()).toHaveTextContent('Click again to discard 3 pending comments');
    expect(overlay()).toHaveClass('tone-danger');
    expect(review.discardReview).not.toHaveBeenCalled();
    clock.settle();
    press(overlay()!);
    await waitFor(() => expect(review.discardReview).toHaveBeenCalledWith('t'));
  });

  it("the composer's buttons come right after the message, before what it says", () => {
    review.session = pendingOf(['5']);
    show(mr, detail, 'gitlab');
    const form = screen.getByRole('form', { name: 'Review' });
    fireEvent.click(within(form).getByRole('radio', { name: 'Request changes' }));
    const textbox = within(form).getByRole('textbox', { name: 'Message' });
    const submit = within(form).getByRole('button', { name: 'Request changes' });
    const note = within(form).getByText(/withdraws your approval/);
    expect(textbox.compareDocumentPosition(submit) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(submit.compareDocumentPosition(note) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // The foot: the buttons' row, then the notes beside it (drawn on its left).
    const foot = form.querySelector('.mr-review-foot')!;
    expect([...foot.children].map((c) => c.className)).toEqual(['mr-form-row', 'mr-review-notes']);
    expect(submit).toHaveClass('primary', 'warn');
  });
});
