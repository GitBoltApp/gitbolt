import { act, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GraphPayload } from '../api/gen/GraphPayload';
import type { RowPayload } from '../api/gen/RowPayload';
import { RepoContext } from '../app/repoContext';
import { useTabViews } from '../app/tabStores';
import { CenterViewHost, centerViewOf, closeCenterView, leaveFileView, openCenterView, registerCenterView, sidebarFor, type CenterViewProps } from './centerView';
import { RepoView } from './RepoView';
import { createRepoViewStore, fileViewTarget } from './store';
import { fakeServices } from './testServices';

vi.mock('../api/transport', () => ({ copyText: vi.fn(async () => {}), inTauri: () => false, createTransport: () => ({ call: () => Promise.reject(new Error('no backend')), subscribe: () => () => {} }) }));
vi.mock('./LazyDiffPanel', () => ({ LazyDiffPanel: ({ target }: { target: { path: string } }) => <section aria-label="Diff">{target.path}</section> }));
HTMLCanvasElement.prototype.getContext = (() => null) as never;

const A = 'a'.repeat(40), B = 'b'.repeat(40);
const row = (id: string, summary: string, parents: string[]): RowPayload => ({ id, kind: 'commit', lane: 0, color: 0, segments: [], summary, bodyFirstLine: '', authorName: 'Grace Hopper', authorEmail: 'grace@example.com', authorTime: 1_767_225_600, committerTime: 1_767_225_600, parents, mrRefs: [], wip: null });
const graph: GraphPayload = { rows: [row(A, 'Second', [B]), row(B, 'First', [])], labels: [], maxLanes: 1, pinnedRef: null, head: { branch: 'refs/heads/main', target: A, detached: false, unborn: false }, truncated: false, worktrees: [] };

function Probe({ props, close }: CenterViewProps<{ title: string }>) {
  const [n, setN] = useState(0);
  return <section aria-label="Probe"><h2>{props.title}</h2><button type="button" onClick={() => setN(n + 1)}>Count {n}</button><button type="button" onClick={close}>Done</button></section>;
}
registerCenterView('probe', Probe);
registerCenterView('crasher', () => { throw new Error('boom'); });
registerCenterView('planner', Probe, { sidebar: 'hide', drivesSelection: true });
afterEach(() => { closeCenterView('t1'); closeCenterView('t2'); });

describe('the center view (spec #3 §4.1, §4.2: a view in the graph\'s place)', () => {
  it('opens a registered view per tab, replaces it, and closes it', () => {
    render(<><CenterViewHost tabId="t1" /><CenterViewHost tabId="t2" /></>);
    act(() => openCenterView('t1', 'probe', { title: 'One' }));
    expect(screen.getByRole('heading')).toHaveTextContent('One');
    act(() => openCenterView('t1', 'probe', { title: 'Two' }));
    expect(screen.getAllByRole('heading')).toHaveLength(1);
    expect(screen.getByRole('heading')).toHaveTextContent('Two');
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(centerViewOf('t1')).toBeNull();
    expect(screen.queryByRole('heading')).toBeNull();
    expect(() => openCenterView('t1', 'nope', {})).toThrow('no center view nope');
    expect(() => registerCenterView('probe', Probe)).toThrow('already registered');
  });

  it('RepoView hides the graph while one is open, and the app\'s Esc leaves the selection to it', () => {
    const store = createRepoViewStore(1, '/r', graph, fakeServices());
    render(
      <RepoContext value={{ tabId: 't1', repoId: 1, path: '/r', worktree: '/r', info: null }}>
        <RepoView repo={1} repoPath="/r" graph={graph} store={store} graphOverlay={<div data-testid="overlay" />} />
      </RepoContext>,
    );
    const rows = screen.getAllByRole('row');
    fireEvent.mouseDown(rows[1]);
    fireEvent.mouseDown(rows[0], { ctrlKey: true });
    act(() => openCenterView('t1', 'probe', { title: 'History' }));
    expect(screen.getByRole('region', { name: 'Probe' })).toBeVisible();
    expect(screen.getByTestId('overlay')).not.toBeVisible();
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(store.getState().selection.kind).toBe('compare');
    act(() => closeCenterView('t1'));
    expect(screen.getByTestId('overlay')).toBeVisible();
  });

  it('a file opened over the view wins; the view waits underneath, its state kept, and comes back when the file closes', () => {
    const store = createRepoViewStore(1, '/r', graph, fakeServices());
    render(
      <RepoContext value={{ tabId: 't1', repoId: 1, path: '/r', worktree: '/r', info: null }}>
        <RepoView repo={1} repoPath="/r" graph={graph} store={store} graphOverlay={<div data-testid="overlay" />} />
      </RepoContext>,
    );
    act(() => openCenterView('t1', 'probe', { title: 'History' }));
    fireEvent.click(screen.getByRole('button', { name: 'Count 0' }));
    act(() => store.getState().openFile(fileViewTarget('src/a.txt', A, { kind: 'commit', id: A, parent: 0 })));
    expect(screen.getByRole('region', { name: 'Diff' })).toBeVisible();
    expect(screen.getByRole('region', { name: 'Diff' })).toHaveTextContent('src/a.txt');
    // Still mounted, hidden (a hidden element has no accessible name, so no role query).
    expect(document.querySelector('section[aria-label="Probe"]')).not.toBeVisible();
    expect(screen.getByTestId('overlay')).not.toBeVisible();
    // Esc closes the file, as over the graph, back to the view.
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(store.getState().diff).toBeNull();
    expect(screen.getByRole('region', { name: 'Probe' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Count 1' })).toBeVisible();
    expect(screen.getByTestId('overlay')).not.toBeVisible();
    expect(centerViewOf('t1')).not.toBeNull();
  });

  it('a view opened over a file is on top, its Esc its own; closing it shows the file again; a file opened after it wins', () => {
    const store = createRepoViewStore(1, '/r', graph, fakeServices());
    useTabViews.setState({ views: { t1: { repo: 1, services: fakeServices(), store } } });
    render(
      <RepoContext value={{ tabId: 't1', repoId: 1, path: '/r', worktree: '/r', info: null }}>
        <RepoView repo={1} repoPath="/r" graph={graph} store={store} graphOverlay={<div data-testid="overlay" />} />
      </RepoContext>,
    );
    const spec = { kind: 'commit', id: A, parent: 0 } as const;
    act(() => store.getState().openFile(fileViewTarget('src/a.txt', A, spec)));
    act(() => openCenterView('t1', 'probe', { title: 'History' }));
    expect(screen.getByRole('region', { name: 'Probe' })).toBeVisible();
    expect(document.querySelector('section[aria-label="Diff"]')).not.toBeVisible();
    // The app's Esc stands aside: the file stays open under the view.
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(store.getState().diff).not.toBeNull();
    act(() => closeCenterView('t1'));
    expect(screen.getByRole('region', { name: 'Diff' })).toHaveTextContent('src/a.txt');
    act(() => openCenterView('t1', 'probe', { title: 'History' }));
    act(() => store.getState().openFile(fileViewTarget('src/b.txt', A, spec)));
    expect(screen.getByRole('region', { name: 'Diff' })).toHaveTextContent('src/b.txt');
    expect(document.querySelector('section[aria-label="Probe"]')).not.toBeVisible();
    useTabViews.setState({ views: {} });
  });

  it('a view that crashes offers Retry and Close, Esc closes it, and the next view opened starts clean', () => {
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    const store = createRepoViewStore(1, '/r', graph, fakeServices());
    render(
      <RepoContext value={{ tabId: 't1', repoId: 1, path: '/r', worktree: '/r', info: null }}>
        <RepoView repo={1} repoPath="/r" graph={graph} store={store} />
      </RepoContext>,
    );
    act(() => openCenterView('t1', 'crasher', {}));
    expect(screen.getByRole('alert')).toHaveTextContent('View crashed: boom');
    expect(screen.getByRole('button', { name: 'Retry' })).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Close view' }));
    expect(centerViewOf('t1')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
    // Esc, from <body>: the app's own Esc stands aside for the view, so the fallback takes it.
    act(() => openCenterView('t1', 'crasher', {}));
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(centerViewOf('t1')).toBeNull();
    // A crash replaced by another view: that one shows, not the crash.
    act(() => openCenterView('t1', 'crasher', {}));
    act(() => openCenterView('t1', 'probe', { title: 'After' }));
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByRole('heading')).toHaveTextContent('After');
    quiet.mockRestore();
  });

  it('UX R2: a view that drives the selection puts the graph\'s back when it closes (or another view replaces it)', () => {
    const store = createRepoViewStore(1, '/r', graph, fakeServices());
    useTabViews.setState({ views: { t1: { repo: 1, services: fakeServices(), store } } });
    const spec = { kind: 'commit', id: A, parent: 0 } as const;
    act(() => { store.getState().selectRow(1); store.getState().selectRow(0, { ctrl: true }); });
    act(() => openCenterView('t1', 'planner', { title: 'Plan' }));
    act(() => { store.getState().selectCommitById(A); store.getState().openFile(fileViewTarget('src/a.txt', A, spec)); });
    // Reopened (a reload): the first snapshot stays.
    act(() => openCenterView('t1', 'planner', { title: 'Plan' }));
    act(() => closeCenterView('t1'));
    expect(store.getState().selection).toEqual({ kind: 'compare', from: B, to: A });
    expect(store.getState().diff).toBeNull();
    // A file open under it comes back with the selection.
    act(() => store.getState().selectRow(1));
    const file = fileViewTarget('src/b.txt', B, { kind: 'commit', id: B, parent: 0 });
    act(() => store.getState().openFile(file));
    act(() => openCenterView('t1', 'planner', { title: 'Plan' }));
    act(() => store.getState().selectCommitById(A));
    act(() => openCenterView('t1', 'probe', { title: 'History' }));
    expect(store.getState().selection).toMatchObject({ kind: 'commit', id: B });
    expect(store.getState().diff).toBe(file);
    // Nothing selected before: nothing after.
    act(() => { closeCenterView('t1'); store.getState().restoreSelection({ rows: [], anchor: null, cursor: null, parent: 0, diff: null }); });
    act(() => openCenterView('t1', 'planner', { title: 'Plan' }));
    act(() => store.getState().selectCommitById(A));
    act(() => closeCenterView('t1'));
    expect(store.getState().selection.kind).toBe('none');
    useTabViews.setState({ views: {} });
  });

  it('UX R2.2: a file opened from the details panel under the view closes with it; a selection rewritten since goes with the next graph', () => {
    const store = createRepoViewStore(1, '/r', graph, fakeServices());
    useTabViews.setState({ views: { t1: { repo: 1, services: fakeServices(), store } } });
    act(() => store.getState().selectRow(1));
    act(() => openCenterView('t1', 'planner', { title: 'Plan' }));
    act(() => { store.getState().selectCommitById(A); store.getState().openFile(fileViewTarget('src/a.txt', A, { kind: 'commit', id: A, parent: 0 })); });
    act(() => closeCenterView('t1'));
    expect(store.getState().selection).toMatchObject({ kind: 'commit', id: B });
    expect(store.getState().diff).toBeNull();
    // Start closes the editor before the rebase; the refresh after it no longer has B: the
    // restored selection goes, nothing pre-rewrite is left.
    const C = 'c'.repeat(40);
    const rewritten: GraphPayload = { ...graph, rows: [row(A, 'Second', [C]), row(C, 'First, rewritten', [])] };
    act(() => store.getState().setGraph(rewritten));
    expect(store.getState().selection.kind).toBe('none');
    expect(store.getState().panel).toBeNull();
    useTabViews.setState({ views: {} });
  });

  it('UX R2.1/R2.3: the rebase editor hides the sidebar while open; a file view on top narrows it, and leaveFileView closes it and its file', () => {
    const store = createRepoViewStore(1, '/r', graph, fakeServices());
    useTabViews.setState({ views: { t1: { repo: 1, services: fakeServices(), store } } });
    const file = fileViewTarget('src/a.txt', A, { kind: 'commit', id: A, parent: 0 });
    expect(sidebarFor(null, null)).toBeNull();
    expect(sidebarFor({ kind: 'planner', over: null }, file)).toBe('hide');
    expect(sidebarFor({ kind: 'probe', over: null }, null)).toBe('narrow');
    expect(sidebarFor({ kind: 'probe', over: null }, file)).toBeNull();
    expect(leaveFileView('t1')).toBe(false);
    act(() => openCenterView('t1', 'planner', {}));
    expect(leaveFileView('t1')).toBe(false);
    expect(centerViewOf('t1')).not.toBeNull();
    act(() => store.getState().openFile(file));
    act(() => openCenterView('t1', 'probe', { title: 'History' }));
    expect(leaveFileView('t1')).toBe(true);
    expect(centerViewOf('t1')).toBeNull();
    expect(store.getState().diff).toBeNull();
    useTabViews.setState({ views: {} });
  });
});
