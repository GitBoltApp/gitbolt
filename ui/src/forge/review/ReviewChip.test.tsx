import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MenuRow } from '../../menu/types';

const poll = vi.hoisted(() => ({ openMrView: vi.fn(), loadMrDetail: vi.fn(async () => {}) }));
vi.mock('../poll', () => poll);
const compare = vi.hoisted(() => ({ compareMr: vi.fn(async () => true) }));
vi.mock('../mrview/compare', () => compare);
const confirm = vi.hoisted(() => ({ confirmAction: vi.fn(async () => true) }));
vi.mock('../../ui/ConfirmDialog', () => confirm);
const review = vi.hoisted(() => ({ discardReview: vi.fn(), submitReview: vi.fn() }));
vi.mock('./session', async () => {
  const { useForge } = await import('../mrStore');
  return { useReview: (tabId: string) => useForge((s) => s.byTab[tabId]?.review ?? null), useReviewPlacements: () => null, discardReview: review.discardReview, submitReview: review.submitReview };
});
// The MR view's composer (MrActions.test covers it): here, that the popover holds it.
const composer = vi.hoisted(() => ({ busy: false }));
vi.mock('../mrview/MrActions', () => ({
  ReviewComposer: ({ number, onDone }: { number: number; onDone: () => void }) => <form aria-label="Review" aria-busy={composer.busy || undefined}>{`composer ${number}`}<button type="button" onClick={onDone}>Cancel</button></form>,
}));

const { chipView, ReviewChip } = await import('./ReviewChip');
const { patchForge, useForge } = await import('../mrStore');
const { RepoContext } = await import('../../app/repoContext');
const { useMenu } = await import('../../menu/menuStore');
const { useToast } = await import('../../ui/toastStore');
const { detailOf, mrOf } = await import('../testMrs');
const { lentHandler } = await import('../../app/lent');
const { EMPTY_PROFILE, useAppState } = await import('../../app/state');

const HEAD = 'h'.repeat(40);
const draft = (id: string) => ({ id, body: id, replyTo: null, position: null });
const session = (over: Record<string, unknown> = {}) => ({ number: 12, kind: 'gitlab' as const, compare: null, refs: null, files: {}, diffHead: HEAD, drafts: [], pendingReview: null, canDraft: true, closed: false, error: null, loaded: true, ...over });
const ctx = { tabId: 't', repoId: 4, path: '/r', worktree: '/r', info: null };
const renderChip = () => render(<RepoContext value={ctx}><ReviewChip /></RepoContext>);
const menuRow = (label: string) => (useMenu.getState().rows ?? []).find((r): r is Extract<MenuRow, { kind: 'action' }> => r.kind === 'action' && r.label === label);

beforeEach(() => {
  vi.clearAllMocks();
  composer.busy = false;
  useMenu.getState().close();
  useToast.getState().dismiss();
  useForge.setState({ byTab: {} });
  useAppState.setState({ loaded: true, profile: { ...EMPTY_PROFILE, id: 'default', tabs: [{ id: 't', kind: 'repo', path: '/r', alias: null }], activeTab: 't' } });
  patchForge('t', { kind: 'gitlab', details: { 12: { value: detailOf(mrOf(12)), at: 1 } } });
});

describe("what the chip says (spec 2026-10-08 §4, §7)", () => {
  it('names the MR/PR and counts the pending comments', () => {
    expect(chipView('gitlab', session({ drafts: [draft('1'), draft('2'), draft('3')] }) as never, mrOf(12)).name).toBe('Reviewing !12 · 3 pending');
  });

  it("GitHub's pending review with no comment yet", () => {
    expect(chipView('github', session({ kind: 'github', pendingReview: 'PRR_9' }) as never, null).name).toBe('Reviewing #12 · review pending');
  });

  it('says when the MR merged under the review, and what can still be done', () => {
    const v = chipView('gitlab', session({ drafts: [draft('1')], closed: true }) as never, mrOf(12, { state: 'merged' }));
    expect(v.value).toBe('!12 merged · 1 pending');
    expect(v.problem).toBe('!12 was merged with your review pending: submit it anyway, or discard it');
  });

  it("says when the review can't be read (lost permissions)", () => {
    const v = chipView('gitlab', session({ drafts: [draft('1')], error: 'GitLab refused: 403 Forbidden' }) as never, mrOf(12));
    expect(v.problem).toBe("Couldn't read your pending review: GitLab refused: 403 Forbidden");
    expect(v.tooltip).toBe(v.problem);
  });
});

describe('the chip', () => {
  it('shows only while a review is pending', () => {
    patchForge('t', { review: session() as never });
    renderChip();
    expect(screen.queryByRole('button', { name: /^Reviewing/ })).toBeNull();
    act(() => patchForge('t', { review: session({ drafts: [draft('1')] }) as never }));
    expect(screen.getByRole('button', { name: 'Reviewing !12 · 1 pending' })).toBeInTheDocument();
  });

  it("a click reopens the MR's view and its Compare", async () => {
    patchForge('t', { review: session({ drafts: [draft('1')] }) as never });
    renderChip();
    fireEvent.click(screen.getByRole('button', { name: 'Reviewing !12 · 1 pending' }));
    await act(async () => {});
    expect(poll.openMrView).toHaveBeenCalledWith('t', 12);
    expect(compare.compareMr).toHaveBeenCalledWith('t', 'gitlab', expect.objectContaining({ number: 12 }), expect.objectContaining({ mr: expect.objectContaining({ number: 12 }) }));
  });

  it('Discard pending review arms its row first, then deletes the drafts on the forge', async () => {
    patchForge('t', { review: session({ drafts: [draft('1'), draft('2')] }) as never });
    review.discardReview.mockResolvedValueOnce({ ok: true, value: 2 });
    renderChip();
    fireEvent.click(screen.getByRole('button', { name: 'Review options' }));
    await act(async () => { menuRow('Discard pending review')!.run(); });
    expect(confirm.confirmAction).toHaveBeenCalledWith(expect.objectContaining({ arm: 'Click again to discard 2 pending comments', danger: true }));
    expect(review.discardReview).toHaveBeenCalledWith('t');
    expect(useToast.getState().message).toBe('Discarded 2 pending comments on !12');
  });

  it('a Discard not confirmed deletes nothing; a refused one says why', async () => {
    patchForge('t', { review: session({ drafts: [draft('1')] }) as never });
    renderChip();
    confirm.confirmAction.mockResolvedValueOnce(false);
    fireEvent.click(screen.getByRole('button', { name: 'Review options' }));
    await act(async () => { menuRow('Discard pending review')!.run(); });
    expect(review.discardReview).not.toHaveBeenCalled();
    review.discardReview.mockResolvedValueOnce({ ok: false, error: 'GitLab refused: 403 Forbidden' });
    await act(async () => { menuRow('Discard pending review')!.run(); });
    expect(useToast.getState().message).toBe("Couldn't discard the review: GitLab refused: 403 Forbidden");
  });
});

describe('Submit review… (spec 2026-10-08 §4)', () => {
  it('the menu row, or Mod+Alt+R, opens the composer under the chip; its Cancel closes it', async () => {
    patchForge('t', { review: session({ drafts: [draft('1')] }) as never });
    renderChip();
    fireEvent.click(screen.getByRole('button', { name: 'Review options' }));
    act(() => { menuRow('Submit review…')!.run(); useMenu.getState().close(); });
    const dialog = await screen.findByRole('dialog', { name: 'Submit your review of !12' });
    expect(within(dialog).getByRole('form', { name: 'Review' })).toHaveTextContent('composer 12');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    // Opened from the menu: focus comes back to the chip.
    expect(screen.getByRole('button', { name: 'Reviewing !12 · 1 pending' })).toHaveFocus();
    act(() => lentHandler('review.submit')!());
    expect(await screen.findByRole('dialog', { name: 'Submit your review of !12' })).toBeInTheDocument();
    // The key that opened it closes it.
    fireEvent.keyDown(window, { key: 'r', code: 'KeyR', ctrlKey: true, altKey: true });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('nothing pending: the key has nothing to open', () => {
    patchForge('t', { review: session() as never });
    renderChip();
    expect(lentHandler('review.submit')).toBeNull();
  });

  it('stays open when the review ends under it (the forge took the comments, not the approval)', async () => {
    patchForge('t', { review: session({ drafts: [draft('1')] }) as never });
    renderChip();
    act(() => lentHandler('review.submit')!());
    await screen.findByRole('dialog', { name: 'Submit your review of !12' });
    act(() => patchForge('t', { review: null }));
    expect(screen.queryByRole('button', { name: /^Reviewing/ })).toBeNull();
    expect(screen.getByRole('dialog', { name: 'Submit your review of !12' })).toBeInTheDocument();
  });

  it("while it sends, Esc and a press outside leave it open: the forge's answer shows there", async () => {
    patchForge('t', { review: session({ drafts: [draft('1')] }) as never });
    composer.busy = true;
    renderChip();
    act(() => lentHandler('review.submit')!());
    const dialog = await screen.findByRole('dialog', { name: 'Submit your review of !12' });
    fireEvent.keyDown(window, { key: 'Escape' });
    fireEvent.pointerDown(document.body);
    expect(dialog).toBeInTheDocument();
  });
});
