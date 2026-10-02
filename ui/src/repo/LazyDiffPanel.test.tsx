import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GraphPayload } from '../api/gen/GraphPayload';
import { LazyDiffPanel } from './LazyDiffPanel';
import { createRepoViewStore, RepoViewContext, targetFor, type DiffTarget } from './store';
import { fakeServices } from './testServices';

const graph: GraphPayload = { rows: [], labels: [], maxLanes: 0, pinnedRef: null, head: { branch: null, target: null, detached: false, unborn: true }, truncated: false, worktrees: [] };
const spec = { kind: 'commit' as const, id: 'c'.repeat(40), parent: 0 };
const target = (path: string) => targetFor({ path, oldPath: null, status: 'M', additions: 1, deletions: 0, old: { kind: 'absent' }, new: { kind: 'absent' }, submodule: false }, spec);

describe('LazyDiffPanel', () => {
  afterEach(() => vi.restoreAllMocks());

  it('a failed load shows the error with Retry and Close; Retry loads the panel again', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    let fail = true;
    const Panel = ({ target: t }: { target: DiffTarget }) => <div data-testid="panel">{t.path}</div>;
    const load = vi.fn(async () => {
      if (fail) throw new Error('Failed to fetch dynamically imported module');
      return { default: Panel };
    });
    const store = createRepoViewStore(1, '/r', graph, fakeServices());
    act(() => store.getState().openFile(target('a.txt')));
    render(<RepoViewContext value={store}><LazyDiffPanel target={target('a.txt')} load={load} /></RepoViewContext>);
    expect(await screen.findByRole('alert')).toHaveTextContent('Failed to fetch dynamically imported module');
    expect(screen.getByRole('region', { name: 'Diff' })).toBeInTheDocument();
    fail = false;
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Retry' })));
    expect(await screen.findByTestId('panel')).toHaveTextContent('a.txt');
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('a panel that throws while rendering shows the error; another file retries, and Close closes the diff', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const Panel = ({ target: t }: { target: DiffTarget }) => {
      if (t.path === 'bad.txt') throw new Error('render exploded');
      return <div data-testid="panel">{t.path}</div>;
    };
    const load = async () => ({ default: Panel });
    const store = createRepoViewStore(1, '/r', graph, fakeServices());
    act(() => store.getState().openFile(target('bad.txt')));
    const view = render(<RepoViewContext value={store}><LazyDiffPanel target={target('bad.txt')} load={load} /></RepoViewContext>);
    expect(await screen.findByRole('alert')).toHaveTextContent('render exploded');
    view.rerender(<RepoViewContext value={store}><LazyDiffPanel target={target('ok.txt')} load={load} /></RepoViewContext>);
    expect(await screen.findByTestId('panel')).toHaveTextContent('ok.txt');
    view.rerender(<RepoViewContext value={store}><LazyDiffPanel target={target('bad.txt')} load={load} /></RepoViewContext>);
    fireEvent.click(await screen.findByRole('button', { name: 'Close diff' }));
    expect(store.getState().diff).toBeNull();
  });

  it('switching File / Diff View clears a render error', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const Panel = ({ target: t }: { target: DiffTarget }) => {
      if (t.view === 'file') throw new Error('file view exploded');
      return <div data-testid="panel">{t.view}</div>;
    };
    const load = async () => ({ default: Panel });
    const store = createRepoViewStore(1, '/r', graph, fakeServices());
    const t = target('a.txt');
    act(() => store.getState().openFile(t));
    const view = render(<RepoViewContext value={store}><LazyDiffPanel target={{ ...t, view: 'file' }} load={load} /></RepoViewContext>);
    expect(await screen.findByRole('alert')).toHaveTextContent('file view exploded');
    view.rerender(<RepoViewContext value={store}><LazyDiffPanel target={t} load={load} /></RepoViewContext>);
    expect(await screen.findByTestId('panel')).toHaveTextContent('diff');
  });

  it('the error fallback is the diff focus zone: a focus request for the diff lands on it', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const load = async (): Promise<{ default: () => never }> => { throw new Error('boom'); };
    const store = createRepoViewStore(1, '/r', graph, fakeServices());
    act(() => store.getState().openFile(target('a.txt')));
    render(<RepoViewContext value={store}><LazyDiffPanel target={target('a.txt')} load={load} /></RepoViewContext>);
    await screen.findByRole('alert');
    const region = screen.getByRole('region', { name: 'Diff' });
    expect(region).toHaveAttribute('data-focus-zone', 'diff');
    act(() => store.getState().setFocus('diff'));
    expect(document.activeElement).toBe(region);
  });

  it('a conflicted WIP file opens the merge tool in place of the diff (spec #2 §13.3)', async () => {
    const Panel = ({ target: t }: { target: DiffTarget }) => <div data-testid="panel">{t.path}</div>;
    const Merge = ({ target: t }: { target: DiffTarget }) => <div data-testid="merge">{t.path}</div>;
    const load = vi.fn(async () => ({ default: Panel }));
    const loadMerge = vi.fn(async () => ({ default: Merge }));
    const wip = { kind: 'wip' as const, worktree: '/r', staged: false };
    const file = (status: string) => targetFor({ path: 'a.txt', oldPath: null, status, additions: 0, deletions: 0, old: { kind: 'absent' }, new: { kind: 'worktree', worktree: '/r' }, submodule: false }, wip);
    const store = createRepoViewStore(1, '/r', graph, fakeServices());
    act(() => store.getState().openFile(file('U')));
    const view = render(<RepoViewContext value={store}><LazyDiffPanel target={file('U')} load={load} loadMerge={loadMerge} /></RepoViewContext>);
    expect(await screen.findByTestId('merge')).toHaveTextContent('a.txt');
    expect(load).not.toHaveBeenCalled();
    view.rerender(<RepoViewContext value={store}><LazyDiffPanel target={file('M')} load={load} loadMerge={loadMerge} /></RepoViewContext>);
    expect(await screen.findByTestId('panel')).toHaveTextContent('a.txt');
    // A commit's file with status U (none, in practice) is a plain diff.
    view.rerender(<RepoViewContext value={store}><LazyDiffPanel target={{ ...target('a.txt'), status: 'U' }} load={load} loadMerge={loadMerge} /></RepoViewContext>);
    expect(await screen.findByTestId('panel')).toBeInTheDocument();
    expect(loadMerge).toHaveBeenCalledTimes(1);
  });
});
