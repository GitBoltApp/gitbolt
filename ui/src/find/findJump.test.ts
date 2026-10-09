import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { GraphPayload } from '../api/gen/GraphPayload';
import type { RowPayload } from '../api/gen/RowPayload';

const N = 40000;
vi.mock('../api/client', () => ({
  api: {
    findText: vi.fn(async () => Array.from({ length: Math.ceil(N / 3) }, (_, i) => `c${i * 3}`)),
    findPaths: vi.fn(async () => []),
    locateCommit: vi.fn(),
    searchHistory: vi.fn(),
  },
  errorMessage: (e: unknown) => String(e),
}));

const { createRepoViewStore } = await import('../repo/store');
const { fakeServices, idle, idleMessages } = await import('../repo/testServices');
const { useTabViews, tabStore } = await import('../app/tabStores');
const { closeFind, openFind, setFindQuery, stepFind, useFind } = await import('./findStore');

const row = (id: string): RowPayload => ({ id, kind: 'commit', lane: 0, color: 0, segments: [], summary: id, bodyFirstLine: '', authorName: 'A', authorEmail: '', authorTime: 0, committerTime: 0, parents: [], mrRefs: [], wip: null });
const graph: GraphPayload = { rows: Array.from({ length: N }, (_, i) => row(`c${i}`)), labels: [], maxLanes: 1, pinnedRefs: [], head: { branch: null, target: null, detached: false, unborn: false }, truncated: false, worktrees: [] };
const state = () => useFind.getState().byTab.t;

beforeEach(async () => {
  const services = fakeServices({ details: idle(), files: idle(), messages: idleMessages() });
  useTabViews.setState({ views: { t: { repo: 1, services, store: createRepoViewStore(1, '/r', graph, services) } } });
  closeFind('t');
  openFind('t');
  await setFindQuery('t', 'x', 0);
});

describe('find jumps on a 40k-row graph (K40)', () => {
  it('next/prev never scan the rows or the matches, and wrap around', () => {
    const rows = tabStore('t')!.getState().graph.rows;
    const spies = [vi.spyOn(rows, 'findIndex'), vi.spyOn(rows, 'indexOf'), vi.spyOn(rows, 'filter'), vi.spyOn(state().matches, 'indexOf'), vi.spyOn(state().matches, 'findIndex')];
    const total = state().matches.length;
    expect(state().index).toBe(0);
    const t = performance.now();
    for (let i = 0; i < 300; i++) stepFind('t', 1);
    const per = (performance.now() - t) / 300;
    for (const s of spies) expect(s).not.toHaveBeenCalled();
    expect(state().index).toBe(300);
    // A loose bound (a loaded machine measured 1.16 ms once); the spies above prove no O(n) scan.
    expect(per).toBeLessThan(5);
    stepFind('t', -1);
    expect(state().index).toBe(299);
    for (let i = 0; i < 300; i++) stepFind('t', -1);
    expect(state().index).toBe(total - 1); // wrapped back past the first
    stepFind('t', 1);
    expect(state().index).toBe(0); // and forward past the last
  });

  it('keeps the row indexes of the matches, in graph order, ready', () => {
    const s = state();
    expect(s.rowIndexes.length).toBe(s.matches.length);
    expect(s.rowIndexes[1]).toBe(3);
    expect(s.rowIndexes[s.rowIndexes.length - 1]).toBe(s.rowIndexes.length * 3 - 3);
  });

  it('counter position follows the selection', () => {
    stepFind('t', 1);
    stepFind('t', 1);
    expect(state().index).toBe(2);
    const sel = tabStore('t')!.getState().selection;
    expect(sel.kind === 'commit' && sel.index).toBe(6);
  });
});
