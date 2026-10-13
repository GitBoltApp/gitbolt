import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createStore } from 'zustand/vanilla';

const api = vi.hoisted(() => ({ mergeBase: vi.fn(), locateCommit: vi.fn() }));
vi.mock('../../api/client', () => ({ api, errorMessage: String }));
const fetching = vi.hoisted(() => ({ runFetch: vi.fn(async () => {}) }));
vi.mock('../../app/fetchSchedule', () => fetching);
// The graph: its loaded rows, and Ctrl+click's compare.
type Graph = { indexById: Map<string, number>; graph?: { rows: { id: string; parents: string[] }[] }; compareCommits: (a: string, b: string) => boolean };
const graph = vi.hoisted(() => ({ store: null as unknown as import('zustand/vanilla').StoreApi<Graph> }));
vi.mock('../../app/tabStores', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../app/tabStores')>()),
  tabStore: () => graph.store,
}));
const review = vi.hoisted(() => ({ startReview: vi.fn(async () => {}) }));
vi.mock('../review/session', () => review);
const poll = vi.hoisted(() => ({ refreshReview: vi.fn(async (_tabId: string) => {}) }));
vi.mock('../poll', () => poll);
const reviewMode = vi.hoisted(() => ({ preloadReviewMode: vi.fn(async () => ({})) }));
vi.mock('../../diff/review/ReviewMode', () => reviewMode);

const { compareMr } = await import('./compare');
const { patchForge, useForge } = await import('../mrStore');
const { useRuntime } = await import('../../app/runtime');
const { useToast } = await import('../../ui/toastStore');
const { detailOf, mrOf } = await import('../testMrs');

const BASE = 'b'.repeat(40);
const MAIN = 'm'.repeat(40);
const FORGE_BASE = 'f'.repeat(40);
const mr = mrOf(12);
const head = mr.headSha!;
const compareCommits = vi.fn((_a: string, _b: string) => true);

beforeEach(() => {
  vi.clearAllMocks();
  graph.store = createStore<Graph>(() => ({ indexById: new Map([[head, 0], [BASE, 5]]), compareCommits }));
  useForge.setState({ byTab: {} });
  patchForge('t', { kind: 'gitlab', remote: 'origin' });
  useRuntime.setState({ tabs: { t: { repo: { id: 4 }, sidebar: { remotes: [{ name: 'origin', branches: [{ name: 'main', fullName: 'refs/remotes/origin/main', target: MAIN }] }] } } as never }, refresh: vi.fn(async () => {}) } as never);
  api.mergeBase.mockResolvedValue(BASE);
  // Not in the repository unless a test says so.
  api.locateCommit.mockRejectedValue({ kind: 'NotFound', message: 'No commit' });
  useToast.getState().dismiss();
});

describe("the branch card's Compare", () => {
  it("compares the merge base of the forge's base and the head with the head, as base then Ctrl+click on the tip", async () => {
    expect(await compareMr('t', 'gitlab', mr, detailOf(mr, { baseSha: FORGE_BASE }))).toBe(true);
    expect(api.mergeBase).toHaveBeenCalledWith(4, FORGE_BASE, head);
    expect(compareCommits).toHaveBeenCalledWith(BASE, head);
    expect(review.startReview).toHaveBeenCalledWith('t', 'gitlab', 12, { from: BASE, to: head });
    // Review mode's cards start loading with the session.
    expect(reviewMode.preloadReviewMode).toHaveBeenCalled();
    expect(fetching.runFetch).not.toHaveBeenCalled();
  });

  it("without the forge's base (or one not fetched), the target's remote tip", async () => {
    api.mergeBase.mockImplementation(async (_r: number, from: string) => (from === MAIN ? BASE : null));
    expect(await compareMr('t', 'github', mr, detailOf(mr, { baseSha: FORGE_BASE }))).toBe(true);
    expect(api.mergeBase).toHaveBeenLastCalledWith(4, MAIN, head);
    expect(compareCommits).toHaveBeenCalledWith(BASE, head);
  });

  it("a head that isn't local is fetched first (its MR ref only, from the target's remote), then compared", async () => {
    graph.store.setState({ indexById: new Map([[BASE, 5]]) });
    (useRuntime.getState().refresh as ReturnType<typeof vi.fn>).mockImplementation(async () => { graph.store.setState({ indexById: new Map([[head, 0], [BASE, 6]]) }); });
    expect(await compareMr('t', 'gitlab', mr, detailOf(mr))).toBe(true);
    expect(fetching.runFetch).toHaveBeenCalledWith('t', false, 'origin', { kind: 'gitlab', number: 12 });
    expect(compareCommits).toHaveBeenCalledWith(BASE, head);
  });

  it('a head in the repository but older than the loaded window loads a deeper one, with no fetch', async () => {
    graph.store.setState({ indexById: new Map([[BASE, 5]]) });
    api.locateCommit.mockResolvedValue({ found: true, limit: 3100 });
    const refresh = useRuntime.getState().refresh as ReturnType<typeof vi.fn>;
    refresh.mockImplementation(async () => { graph.store.setState({ indexById: new Map([[head, 3050], [BASE, 3060]]) }); });
    expect(await compareMr('t', 'gitlab', mr, detailOf(mr))).toBe(true);
    expect(useRuntime.getState().tabs.t?.limit).toBe(3100);
    expect(fetching.runFetch).not.toHaveBeenCalled();
    expect(compareCommits).toHaveBeenCalledWith(BASE, head);
  });

  it("the tab's review of the MR compares at its diff refs, read again first, newer than the cached detail: Compare again lands on the current head", async () => {
    const NEW = 'n'.repeat(40);
    const REVIEW_BASE = 'r'.repeat(40);
    graph.store.setState({ indexById: new Map([[head, 0], [NEW, 1], [BASE, 5]]) });
    patchForge('t', { review: { number: 12, kind: 'gitlab', compare: { from: BASE, to: head }, refs: { baseSha: BASE, startSha: BASE, headSha: head }, files: {}, diffHead: head, drafts: [], pendingReview: null, canDraft: true, closed: false, error: null, loaded: true } });
    // The forge, read now: the author pushed.
    poll.refreshReview.mockImplementationOnce(async () => patchForge('t', (f) => ({ review: { ...f.review!, refs: { baseSha: REVIEW_BASE, startSha: REVIEW_BASE, headSha: NEW }, diffHead: NEW } })));
    expect(await compareMr('t', 'gitlab', mr, detailOf(mr, { baseSha: FORGE_BASE }))).toBe(true);
    expect(poll.refreshReview).toHaveBeenCalledWith('t');
    expect(api.mergeBase).toHaveBeenCalledWith(4, REVIEW_BASE, NEW);
    expect(compareCommits).toHaveBeenCalledWith(BASE, NEW);
    expect(review.startReview).toHaveBeenCalledWith('t', 'gitlab', 12, { from: BASE, to: NEW });
    // Another MR's review: the detail's head, as before.
    vi.clearAllMocks();
    const other = mrOf(13);
    graph.store.setState({ indexById: new Map([[other.headSha!, 0], [BASE, 5]]) });
    expect(await compareMr('t', 'gitlab', other, detailOf(other))).toBe(true);
    expect(compareCommits).toHaveBeenCalledWith(BASE, other.headSha);
    expect(poll.refreshReview).not.toHaveBeenCalled();
  });

  describe('a merged one: the commit it landed as, against its first parent, never a ref of its own', () => {
    const LANDED = 'a'.repeat(40);
    const BEFORE = 'c'.repeat(40);
    const merged = mrOf(12, { state: 'merged' });
    // The trunk: the merge (its first parent the trunk before it, its second the MR's head).
    const trunk = { indexById: new Map([[LANDED, 0], [BEFORE, 1]]), graph: { rows: [{ id: LANDED, parents: [BEFORE, head] }, { id: BEFORE, parents: [] }] } };
    const refresh = () => useRuntime.getState().refresh as ReturnType<typeof vi.fn>;

    it('in the repository: compared at once, no fetch, and no review starts', async () => {
      graph.store.setState(trunk);
      expect(await compareMr('t', 'gitlab', merged, detailOf(merged, { mergedSha: LANDED }))).toBe(true);
      expect(compareCommits).toHaveBeenCalledWith(BEFORE, LANDED);
      expect(fetching.runFetch).not.toHaveBeenCalled();
      expect(review.startReview).not.toHaveBeenCalled();
    });

    it("not fetched yet: the remote's branches are fetched (not the MR's head ref), then compared", async () => {
      graph.store.setState({ indexById: new Map([[BASE, 5]]) });
      refresh().mockImplementation(async () => { graph.store.setState(trunk); });
      expect(await compareMr('t', 'github', merged, detailOf(merged, { mergedSha: LANDED }))).toBe(true);
      expect(fetching.runFetch).toHaveBeenCalledTimes(1);
      expect(fetching.runFetch).toHaveBeenCalledWith('t', false, 'origin');
      expect(compareCommits).toHaveBeenCalledWith(BEFORE, LANDED);
    });

    it("one the remote doesn't have either: says so, and nothing else is fetched or compared", async () => {
      graph.store.setState({ indexById: new Map([[BASE, 5]]) });
      expect(await compareMr('t', 'gitlab', merged, detailOf(merged, { mergedSha: LANDED }))).toBe(false);
      expect(useToast.getState().message).toBe("The merge request was merged as aaaaaa, which isn't on origin");
      expect(fetching.runFetch).toHaveBeenCalledTimes(1);
      expect(fetching.runFetch).toHaveBeenCalledWith('t', false, 'origin');
      expect(compareCommits).not.toHaveBeenCalled();
      expect(review.startReview).not.toHaveBeenCalled();
    });

    it('fast-forwarded (no merge or squash commit named): its head, which a fetch of the branches brings', async () => {
      graph.store.setState({ indexById: new Map([[BASE, 5]]) });
      expect(await compareMr('t', 'gitlab', merged, detailOf(merged))).toBe(false);
      expect(fetching.runFetch).toHaveBeenCalledWith('t', false, 'origin');
      expect(useToast.getState().message).toBe("The merged merge request's commits aren't on origin");
      vi.clearAllMocks();
      refresh().mockImplementation(async () => { graph.store.setState({ indexById: new Map([[head, 0], [BASE, 6]]) }); });
      expect(await compareMr('t', 'gitlab', merged, detailOf(merged))).toBe(true);
      expect(fetching.runFetch).toHaveBeenCalledWith('t', false, 'origin');
      expect(compareCommits).toHaveBeenCalledWith(BASE, head);
    });
  });

  it('says why when the base or the head is out of reach', async () => {
    api.mergeBase.mockResolvedValue(null);
    expect(await compareMr('t', 'gitlab', mr, detailOf(mr))).toBe(false);
    expect(useToast.getState().message).toBe("The merge request's base isn't in this repository: fetch first");
    expect(compareCommits).not.toHaveBeenCalled();
  });
});
