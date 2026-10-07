import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createStore } from 'zustand/vanilla';

const api = vi.hoisted(() => ({ mergeBase: vi.fn(), locateCommit: vi.fn() }));
vi.mock('../../api/client', () => ({ api, errorMessage: String }));
const fetching = vi.hoisted(() => ({ runFetch: vi.fn(async () => {}) }));
vi.mock('../../app/fetchSchedule', () => fetching);
// The graph: its loaded rows, and Ctrl+click's compare.
type Graph = { indexById: Map<string, number>; compareCommits: (a: string, b: string) => boolean };
const graph = vi.hoisted(() => ({ store: null as unknown as import('zustand/vanilla').StoreApi<Graph> }));
vi.mock('../../app/tabStores', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../app/tabStores')>()),
  tabStore: () => graph.store,
}));

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

  it('says why when the base or the head is out of reach', async () => {
    api.mergeBase.mockResolvedValue(null);
    expect(await compareMr('t', 'gitlab', mr, detailOf(mr))).toBe(false);
    expect(useToast.getState().message).toBe("The merge request's base isn't in this repository: fetch first");
    expect(compareCommits).not.toHaveBeenCalled();
  });
});
