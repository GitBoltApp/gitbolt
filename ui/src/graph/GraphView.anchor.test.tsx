import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { GraphPayload } from '../api/gen/GraphPayload';
import type { RowPayload } from '../api/gen/RowPayload';
import { RepoView } from '../repo/RepoView';
import { createRepoViewStore, type DiffTarget } from '../repo/store';
import { fakeServices } from '../repo/testServices';
import { METRICS } from './metrics';

vi.mock('../api/transport', () => ({ copyText: vi.fn(async () => {}), inTauri: () => false }));
// The diff panel's content is beside the point here: only that it takes over the center.
vi.mock('../repo/LazyDiffPanel', () => ({ LazyDiffPanel: () => <section aria-label="Diff" /> }));
HTMLCanvasElement.prototype.getContext = (() => null) as never;

// A 600 px tall, 1200 px wide viewport (jsdom lays nothing out).
const saved = { w: Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth'), h: Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientHeight'), p: Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetParent') };
beforeAll(() => {
  // Laid out unless inside <Activity mode="hidden"> (display: none), as a browser reports it.
  Object.defineProperty(HTMLElement.prototype, 'offsetParent', { configurable: true, get(this: HTMLElement) { return this.closest('[style*="display: none"]') ? null : document.body; } });
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, value: 1200 });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, value: 600 });
});
afterAll(() => {
  if (saved.w) Object.defineProperty(HTMLElement.prototype, 'clientWidth', saved.w);
  if (saved.h) Object.defineProperty(HTMLElement.prototype, 'clientHeight', saved.h);
  if (saved.p) Object.defineProperty(HTMLElement.prototype, 'offsetParent', saved.p);
});

const row = (name: string): RowPayload => ({ id: name.padEnd(40, '0'), kind: 'commit', lane: 0, color: 0, segments: [], summary: name, bodyFirstLine: '', authorName: 'A', authorEmail: '', authorTime: 0, committerTime: 0, parents: [], mrRefs: [], wip: null });
const graphOf = (names: string[]): GraphPayload => ({ rows: names.map(row), labels: [], maxLanes: 1, pinnedRef: null, head: { branch: null, target: null, detached: false, unborn: false }, truncated: false, worktrees: [] });
const names = (n: number, prefix = 'c') => Array.from({ length: n }, (_, i) => `${prefix}${i}`);
const rowH = METRICS.rowH;
const target: DiffTarget = { key: 'k|a.txt', path: 'a.txt', oldPath: null, status: 'M', old: { kind: 'absent' }, new: { kind: 'absent' }, view: 'diff' };

function mount(g: GraphPayload) {
  const store = createRepoViewStore(1, '/r', g, fakeServices());
  const view = render(<RepoView repo={1} repoPath="/r" graph={g} store={store} />);
  const grid = screen.getByRole('grid', { name: 'Commit graph' });
  const refresh = (next: GraphPayload) => {
    // What a tab's refresh does: the store first (tabStores.feedTabView), then the prop.
    act(() => store.getState().setGraph(next));
    view.rerender(<RepoView repo={1} repoPath="/r" graph={next} store={store} />);
  };
  return { store, grid, refresh };
}

const selectedSummary = () => screen.getAllByRole('row').filter((r) => r.getAttribute('aria-selected') === 'true').map((r) => r.textContent);

describe('GraphView across refreshes (spec §4.4: keeps the selection and scroll)', () => {
  it('RepoView shows the store it is given', () => {
    const g = graphOf(names(5));
    const { store } = mount(g);
    act(() => { store.getState().selectCommitById(row('c3').id); });
    expect(selectedSummary()).toEqual([expect.stringContaining('c3')]);
  });

  it('commits arriving above keep the selected commit selected and in the same place on screen', () => {
    const g = graphOf(names(100));
    const { store, grid, refresh } = mount(g);
    act(() => { store.getState().selectCommitById(row('c12').id); });
    grid.scrollTop = 5 * rowH;
    fireEvent.scroll(grid);
    refresh(graphOf(['n0', 'n1', 'n2', ...names(100)]));
    expect(grid.scrollTop).toBe(8 * rowH);
    expect(selectedSummary()).toEqual([expect.stringContaining('c12')]);
  });

  it('without a selection on screen, the top row stays put', () => {
    const g = graphOf(names(100));
    const { store, grid, refresh } = mount(g);
    // Selected, but scrolled far away from it: the top row anchors instead.
    act(() => { store.getState().selectCommitById(row('c1').id); });
    grid.scrollTop = 40 * rowH;
    fireEvent.scroll(grid);
    refresh(graphOf(['n0', 'n1', ...names(100)]));
    expect(grid.scrollTop).toBe(42 * rowH);
  });

  it('a refresh while the graph is hidden under a diff is anchored when it shows again', async () => {
    const g = graphOf(names(100));
    const { store, grid, refresh } = mount(g);
    act(() => { store.getState().selectCommitById(row('c12').id); });
    grid.scrollTop = 5 * rowH;
    fireEvent.scroll(grid);
    act(() => store.getState().openFile(target));
    // Hidden (display: none): a hidden element loses its scroll offset.
    expect(grid.closest('[style*="display: none"]')).not.toBeNull();
    grid.scrollTop = 0;
    refresh(graphOf(['n0', 'n1', 'n2', ...names(100)]));
    act(() => store.getState().closeDiff());
    expect(grid.closest('[style*="display: none"]')).toBeNull();
    expect(grid.scrollTop).toBe(8 * rowH);
    expect(selectedSummary()).toEqual([expect.stringContaining('c12')]);
  });

  it('at the very top, rows arriving above stay in view: the scroll stays at 0, the selection follows its commit (K37)', () => {
    const g = graphOf(names(100));
    const { store, grid, refresh } = mount(g);
    act(() => { store.getState().selectCommitById(row('c0').id); });
    expect(grid.scrollTop).toBe(0);
    refresh(graphOf(['wip', ...names(100)]));
    expect(grid.scrollTop).toBe(0);
    expect(screen.getAllByRole('row')[0].textContent).toContain('wip');
    expect(selectedSummary()).toEqual([expect.stringContaining('c0')]);
  });

  it('at the very top without a selection, rows arriving above stay in view too', () => {
    const { grid, refresh } = mount(graphOf(names(100)));
    refresh(graphOf(['n0', 'wip', ...names(100)]));
    expect(grid.scrollTop).toBe(0);
    expect(screen.getAllByRole('row')[0].textContent).toContain('n0');
  });

  it('a refresh that changes nothing above leaves the scroll alone', () => {
    const g = graphOf(names(100));
    const { grid, refresh } = mount(g);
    grid.scrollTop = 7 * rowH;
    fireEvent.scroll(grid);
    refresh(graphOf([...names(100), 'older']));
    expect(grid.scrollTop).toBe(7 * rowH);
  });
});
