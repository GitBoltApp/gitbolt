import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createStore, type StoreApi } from 'zustand/vanilla';

const api = vi.hoisted(() => ({
  forgeReviewDrafts: vi.fn(), forgeReviewDiff: vi.fn(), forgeAddDraft: vi.fn(), forgeCommentNow: vi.fn(),
  forgeEditDraft: vi.fn(), forgeDeleteDraft: vi.fn(), forgeSubmitReview: vi.fn(), forgeDiscardReview: vi.fn(),
}));
vi.mock('../../api/client', () => ({ api, errorMessage: (e: unknown) => (e && typeof e === 'object' && 'message' in e ? String((e as { message: unknown }).message) : String(e)) }));
const polling = vi.hoisted(() => ({ notifyForgeWrite: vi.fn() }));
vi.mock('../usePolling', () => polling);
type Graph = { selection: { kind: string; from?: string; to?: string } };
const graph = vi.hoisted(() => ({ store: null as unknown as StoreApi<{ selection: { kind: string; from?: string; to?: string } }> }));
vi.mock('../../app/tabStores', async (importOriginal) => ({ ...(await importOriginal<typeof import('../../app/tabStores')>()), tabStore: () => graph.store }));

const { addToReview, commentNow, discardReview, resumeReview, startReview, submitReview } = await import('./session');
const { refreshReview } = await import('../poll');
const { dropForge, forgeOf, forgeScratch, patchForge, useForge } = await import('../mrStore');
const { useRuntime } = await import('../../app/runtime');
const { detailOf, mrOf } = await import('../testMrs');

const BASE = 'b'.repeat(40);
const HEAD = String(12).padStart(40, '0');
const NEXT = 'n'.repeat(40);
const COMPARE = { from: BASE, to: HEAD };
const LINE = { kind: 'added' as const, oldLine: 2, newLine: 2 };
const refs = (head = HEAD) => ({ baseSha: BASE, startSha: BASE, headSha: head });
const diff = (head = HEAD) => ({ refs: refs(head), files: [{ path: 'README.md', oldPath: 'README.md', tooLarge: false, lines: [{ kind: 'context' as const, oldLine: 1, newLine: 1 }, LINE] }] });
const draft = (id: string, body: string) => ({ id, body, replyTo: null, position: { path: 'README.md', oldPath: null, line: 2, oldLine: null, snippet: null, startLine: null, startOldLine: null, headSha: HEAD } });
const pending = (list: ReturnType<typeof draft>[], head = HEAD) => ({ refs: refs(head), drafts: list, pendingReview: null, canDraft: true });
const anchor = { path: 'README.md', oldPath: 'README.md', start: null, end: LINE };
const showCompare = () => graph.store.setState({ selection: { kind: 'compare', ...COMPARE } });

beforeEach(() => {
  vi.clearAllMocks();
  dropForge('t');
  useForge.setState({ byTab: {} });
  graph.store = createStore<Graph>(() => ({ selection: { kind: 'compare', ...COMPARE } }));
  useRuntime.setState({ tabs: { t: { repo: { id: 4 } } as never } });
  patchForge('t', { kind: 'gitlab', remote: 'origin' });
  api.forgeReviewDrafts.mockResolvedValue(pending([]));
  api.forgeReviewDiff.mockResolvedValue(diff());
});

describe('the review session (spec §1)', () => {
  it('Compare starts it; it reads the drafts each refresh and the diff once per head', async () => {
    await startReview('t', 'gitlab', 12, COMPARE);
    const s = forgeOf('t').review!;
    expect([s.number, s.loaded, s.diffHead, s.files['README.md']?.new[2]]).toEqual([12, true, HEAD, LINE]);
    await refreshReview('t');
    expect(api.forgeReviewDiff).toHaveBeenCalledTimes(1);
    // The author pushed: the refs move to the new head and its diff is read; the drafts keep theirs.
    api.forgeReviewDrafts.mockResolvedValue(pending([draft('5', 'Why?')], NEXT));
    api.forgeReviewDiff.mockResolvedValue(diff(NEXT));
    await refreshReview('t');
    const after = forgeOf('t').review!;
    expect(api.forgeReviewDiff).toHaveBeenCalledTimes(2);
    expect([after.refs?.headSha, after.diffHead, after.drafts[0]?.position?.headSha]).toEqual([NEXT, NEXT, HEAD]);
  });

  it('reads the diff again when any of its refs moves: the target branch changed under the same head', async () => {
    await startReview('t', 'gitlab', 12, COMPARE);
    const moved = { baseSha: 'c'.repeat(40), startSha: 'c'.repeat(40), headSha: HEAD };
    api.forgeReviewDrafts.mockResolvedValue({ ...pending([]), refs: moved });
    api.forgeReviewDiff.mockResolvedValue({ ...diff(), refs: moved });
    await refreshReview('t');
    await refreshReview('t');
    expect(api.forgeReviewDiff).toHaveBeenCalledTimes(2);
    expect(forgeOf('t').review?.refs).toEqual(moved);
  });

  it("takes the refs from the diff it read, so the refs and the lines name the same commits", async () => {
    const forDiff = { baseSha: 'c'.repeat(40), startSha: 'c'.repeat(40), headSha: HEAD };
    api.forgeReviewDiff.mockResolvedValueOnce({ ...diff(), refs: forDiff });
    await startReview('t', 'gitlab', 12, COMPARE);
    expect([forgeOf('t').review?.refs, forgeOf('t').review?.diffHead]).toEqual([forDiff, HEAD]);
  });

  it("a diff that fails keeps the last lines, but the drafts read still counts", async () => {
    api.forgeReviewDrafts.mockResolvedValue(pending([draft('5', 'Why?')]));
    api.forgeReviewDiff.mockRejectedValueOnce({ kind: 'Network', message: 'gitlab.example.com timed out' });
    await startReview('t', 'gitlab', 12, COMPARE);
    const s = forgeOf('t').review!;
    expect([s.loaded, s.drafts.map((d) => d.id), s.error, s.refs, s.diffHead, s.files]).toEqual([true, ['5'], 'gitlab.example.com timed out', null, null, {}]);
    await refreshReview('t');
    expect([forgeOf('t').review?.error, forgeOf('t').review?.diffHead]).toEqual([null, HEAD]);
  });

  it('a session whose first refresh failed ends with its Compare', async () => {
    api.forgeReviewDrafts.mockRejectedValue({ kind: 'Network', message: 'gitlab.example.com timed out' });
    await startReview('t', 'gitlab', 12, COMPARE);
    expect(forgeOf('t').review?.loaded).toBe(false);
    graph.store.setState({ selection: { kind: 'commit' } });
    expect(forgeOf('t').review).toBeNull();
  });

  it('a refused draft keeps nothing and says why; one that goes in shows at once', async () => {
    await startReview('t', 'gitlab', 12, COMPARE);
    api.forgeAddDraft.mockRejectedValueOnce({ kind: 'InvalidInput', message: "GitLab won't take a comment on that line: 400 Bad request" });
    expect(await addToReview('t', anchor, 'Why?')).toEqual({ ok: false, error: "GitLab won't take a comment on that line: 400 Bad request" });
    expect(forgeOf('t').review?.drafts).toEqual([]);
    api.forgeAddDraft.mockResolvedValueOnce(draft('5', 'Why?'));
    api.forgeReviewDrafts.mockResolvedValue(pending([draft('5', 'Why?')]));
    expect((await addToReview('t', anchor, 'Why?')).ok).toBe(true);
    expect(api.forgeAddDraft).toHaveBeenLastCalledWith(4, 12, { anchor, body: 'Why?', refs: refs() });
    expect(forgeOf('t').review?.drafts.map((d) => d.id)).toEqual(['5']);
  });

  it('Comment now puts the thread on the MR at once and has the poller read it back', async () => {
    const thread = { id: 'd9', notes: [], resolvable: true, resolved: false };
    api.forgeCommentNow.mockResolvedValueOnce(thread);
    await startReview('t', 'gitlab', 12, COMPARE);
    expect(await commentNow('t', anchor, 'Typo?')).toEqual({ ok: true, value: thread });
    expect(forgeOf('t').discussions[12]).toEqual([thread]);
    expect(polling.notifyForgeWrite).toHaveBeenCalledWith('t');
  });

  it('it ends when its Compare closes with nothing pending; pending drafts keep it, and a merge marks it', async () => {
    await startReview('t', 'gitlab', 12, COMPARE);
    graph.store.setState({ selection: { kind: 'commit' } });
    expect(forgeOf('t').review).toBeNull();

    showCompare();
    api.forgeReviewDrafts.mockResolvedValue(pending([draft('5', 'Why?')]));
    await startReview('t', 'gitlab', 12, COMPARE);
    graph.store.setState({ selection: { kind: 'commit' } });
    expect(forgeOf('t').review?.drafts).toHaveLength(1);
    patchForge('t', { details: { 12: { value: detailOf(mrOf(12, { state: 'merged' })), at: 1 } } });
    await refreshReview('t');
    expect(forgeOf('t').review?.closed).toBe(true);

    api.forgeDiscardReview.mockResolvedValueOnce(1);
    api.forgeReviewDrafts.mockResolvedValue(pending([]));
    expect(await discardReview('t')).toEqual({ ok: true, value: 1 });
    expect(forgeOf('t').review).toBeNull();
  });

  it('a merged MR with nothing pending ends it, even with its Compare shown', async () => {
    patchForge('t', { details: { 12: { value: detailOf(mrOf(12, { state: 'merged' })), at: 1 } } });
    await startReview('t', 'gitlab', 12, COMPARE);
    expect(forgeOf('t').review).toBeNull();
  });

  it('a submit clears what was pending and returns what went through, the refused event included', async () => {
    api.forgeReviewDrafts.mockResolvedValue(pending([draft('5', 'Why?')]));
    await startReview('t', 'gitlab', 12, COMPARE);
    const outcome = { published: 1, eventError: 'gitlab.example.com refused: 403 Forbidden', bodyPosted: false, eventSent: false, fallback: false };
    api.forgeSubmitReview.mockResolvedValueOnce(outcome);
    api.forgeReviewDrafts.mockResolvedValue(pending([]));
    expect(await submitReview('t', { event: 'approve', body: '' })).toEqual({ ok: true, value: outcome });
    // Its Compare is still shown: the session stays, with nothing pending.
    expect([forgeOf('t').review?.drafts, forgeOf('t').review?.pendingReview]).toEqual([[], null]);
    expect(polling.notifyForgeWrite).toHaveBeenCalledWith('t');
  });

  it("swapping the Compare's direction keeps it", async () => {
    await startReview('t', 'gitlab', 12, COMPARE);
    graph.store.setState({ selection: { kind: 'compare', from: HEAD, to: BASE } });
    expect(forgeOf('t').review?.number).toBe(12);
    showCompare();
    expect(forgeOf('t').review?.number).toBe(12);
  });

  it('a closed tab drops its session and stops watching its Compare', async () => {
    await startReview('t', 'gitlab', 12, COMPARE);
    expect(forgeScratch.reviewUnsub.has('t')).toBe(true);
    dropForge('t');
    expect(forgeScratch.reviewUnsub.has('t')).toBe(false);
    graph.store.setState({ selection: { kind: 'commit' } });
    expect(forgeOf('t').review).toBeNull();
  });

  it("a write that answers after another MR's review started leaves that review alone", async () => {
    api.forgeReviewDrafts.mockImplementation(async (_repo: number, n: number) => pending(n === 15 ? [draft('7', 'Mine')] : []));
    const held = <T,>() => { let done!: (v: T) => void; const p = new Promise<T>((r) => { done = r; }); return { p, done }; };

    await startReview('t', 'gitlab', 12, COMPARE);
    const add = held<ReturnType<typeof draft>>();
    api.forgeAddDraft.mockReturnValueOnce(add.p);
    const adding = addToReview('t', anchor, 'Why?');
    await startReview('t', 'gitlab', 15, COMPARE);
    add.done(draft('5', 'Why?'));
    expect((await adding).ok).toBe(true);
    expect([forgeOf('t').review?.number, forgeOf('t').review?.drafts.map((d) => d.id)]).toEqual([15, ['7']]);

    await startReview('t', 'gitlab', 12, COMPARE);
    const submit = held<{ published: number; eventError: null; bodyPosted: boolean; eventSent: boolean; fallback: boolean }>();
    api.forgeSubmitReview.mockReturnValueOnce(submit.p);
    const submitting = submitReview('t', { event: 'comment', body: '' });
    await startReview('t', 'gitlab', 15, COMPARE);
    submit.done({ published: 0, eventError: null, bodyPosted: false, eventSent: false, fallback: false });
    expect((await submitting).ok).toBe(true);
    expect([forgeOf('t').review?.number, forgeOf('t').review?.drafts.map((d) => d.id)]).toEqual([15, ['7']]);
  });
});

describe('a review left pending outside the session (fix round 1)', () => {
  const noCompare = () => graph.store.setState({ selection: { kind: 'commit' } });

  it("GitLab's drafts on the MR opened start a session without a Compare, so the chip and the composer see them", async () => {
    noCompare();
    api.forgeReviewDrafts.mockResolvedValueOnce(pending([draft('5', 'Why?')]));
    await resumeReview('t', 12);
    expect(api.forgeReviewDrafts).toHaveBeenCalledWith(4, 12);
    const s = forgeOf('t').review!;
    expect([s.number, s.kind, s.compare, s.loaded, s.drafts.map((d) => d.id)]).toEqual([12, 'gitlab', null, true, ['5']]);
    // It lives while the drafts do: another selection keeps it.
    noCompare();
    expect(forgeOf('t').review?.number).toBe(12);
  });

  it("GitHub's pending review with no comment yet starts one too", async () => {
    noCompare();
    patchForge('t', { kind: 'github' });
    api.forgeReviewDrafts.mockResolvedValueOnce({ refs: refs(), drafts: [], pendingReview: 'PRR_9', canDraft: true });
    await resumeReview('t', 12);
    expect([forgeOf('t').review?.kind, forgeOf('t').review?.pendingReview]).toEqual(['github', 'PRR_9']);
  });

  it('nothing pending, or a read that fails: no session', async () => {
    noCompare();
    await resumeReview('t', 12);
    expect(forgeOf('t').review).toBeNull();
    api.forgeReviewDrafts.mockRejectedValueOnce(new Error('gitlab.example.com refused: 403 Forbidden'));
    await resumeReview('t', 12);
    expect(forgeOf('t').review).toBeNull();
  });

  it("the MR's own session isn't read again; another MR's with drafts, or with its Compare shown, stays", async () => {
    api.forgeReviewDrafts.mockResolvedValue(pending([draft('5', 'Why?')]));
    await startReview('t', 'gitlab', 15, COMPARE);
    api.forgeReviewDrafts.mockClear();
    await resumeReview('t', 15);
    expect(api.forgeReviewDrafts).not.toHaveBeenCalled();
    await resumeReview('t', 12);
    expect(forgeOf('t').review?.number).toBe(15);

    api.forgeReviewDrafts.mockResolvedValue(pending([]));
    await startReview('t', 'gitlab', 16, COMPARE);
    api.forgeReviewDrafts.mockResolvedValue(pending([draft('8', 'Hm')]));
    await resumeReview('t', 12);
    expect(forgeOf('t').review?.number).toBe(16);

    // Its Compare closed with nothing pending: the MR opened takes the tab's session.
    noCompare();
    expect(forgeOf('t').review).toBeNull();
    await resumeReview('t', 12);
    expect(forgeOf('t').review?.number).toBe(12);
  });
});
