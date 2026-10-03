import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import type { FileChange } from '../api/gen/FileChange';
import type { FileListPayload } from '../api/gen/FileListPayload';
import type { GraphPayload } from '../api/gen/GraphPayload';
import { useFileListPrefs } from '../files/fileListPrefs';
import { createRepoViewStore, RepoViewContext, type FileSection } from '../repo/store';
import { fakeServices } from '../repo/testServices';
import { WipSections } from './WipSections';
import { loadWipPanel, WIP_PANEL, wipSplitBounds } from './wipPanelPrefs';

const file = (path: string): FileChange => ({ path, oldPath: null, status: 'M', additions: 1, deletions: 0, old: { kind: 'absent' }, new: { kind: 'worktree', worktree: '/r' }, submodule: false });
const list = (...paths: string[]): FileListPayload => ({ files: paths.map(file), added: paths.length, deleted: 0 });
const section = (title: string, staged: boolean, ...paths: string[]): FileSection => ({ title, spec: { kind: 'wip', worktree: '/r', staged }, list: { status: 'ready', data: list(...paths) } });
const graph: GraphPayload = { rows: [], labels: [], maxLanes: 1, pinnedRef: null, head: { branch: null, target: null, detached: false, unborn: true }, truncated: false, worktrees: [] };

function setup() {
  const store = createRepoViewStore(1, '/r', graph, fakeServices());
  const sections = [section('Unstaged', false, 'src/a.txt', 'src/b.txt'), section('Staged', true, 'lib/c.txt')];
  const view = render(<RepoViewContext value={store}><WipSections sections={sections} /></RepoViewContext>);
  return { store, view };
}
const stored = () => JSON.parse(localStorage.getItem(WIP_PANEL.key) ?? 'null');

beforeEach(() => {
  localStorage.clear();
  useFileListPrefs.setState({ mode: 'path', sort: 'path', allFiles: false });
});

describe('WipSections (K36)', () => {
  it('Conflicted comes first with each file’s kind, and its files are in neither other list (spec #2 §7.1)', () => {
    const store = createRepoViewStore(1, '/r', graph, fakeServices());
    const c = { ...file('c.txt'), status: 'U', conflict: 'bothModified' as const };
    const sections = [
      { ...section('Unstaged', false), list: { status: 'ready', data: { files: [file('a.txt'), c], added: 2, deleted: 0 } } } as FileSection,
      section('Staged', true, 'b.txt'),
    ];
    render(<RepoViewContext value={store}><WipSections sections={sections} /></RepoViewContext>);
    const heads = screen.getAllByRole('heading').map((h) => h.textContent);
    expect(heads).toEqual(['Conflicted (1)', 'Unstaged (1)', 'Staged (1)']);
    expect(screen.getByText('changed in both')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Stage c\.txt/ })).toBeNull();
  });

  it('K86: no +0/−0 totals for an empty side; a one-sided change shows only that side', () => {
    const store = createRepoViewStore(1, '/r', graph, fakeServices());
    const sections = [section('Unstaged', false), { ...section('Staged', true, 'a.txt'), list: { status: 'ready', data: { files: [file('a.txt')], added: 0, deleted: 3 } } } as FileSection];
    render(<RepoViewContext value={store}><WipSections sections={sections} /></RepoViewContext>);
    expect(screen.queryByTestId('unstaged-totals')).toBeNull();
    expect(screen.getByTestId('staged-totals')).toHaveTextContent(/^−3$/);
  });
  it('one shared Path/Tree toggle drives both lists; the lists have none of their own', () => {
    setup();
    expect(screen.getAllByRole('button', { name: 'Path' })).toHaveLength(1);
    expect(screen.getAllByRole('button', { name: 'Tree' })).toHaveLength(1);
    expect(screen.getAllByRole('option').every((o) => o.getAttribute('data-kind') === 'file')).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Tree' }));
    expect(screen.getAllByRole('treeitem').filter((o) => o.getAttribute('data-kind') === 'folder').map((o) => o.getAttribute('data-path'))).toEqual(['src', 'lib']);
    // The same pref commit details use.
    expect(useFileListPrefs.getState().mode).toBe('tree');
  });

  it('puts the counts, summary and +/- totals on the section header line, with no stage/discard buttons', () => {
    setup();
    expect(screen.getByRole('heading', { name: 'Unstaged (2)' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Staged (1)' })).toBeInTheDocument();
    expect(screen.getByTestId('unstaged-totals')).toHaveTextContent(/^\+2$/);
    expect(screen.getByTestId('unstaged-counts')).toBeInTheDocument();
    expect(screen.getByTestId('unstaged-totals').parentElement).toBe(screen.getByRole('heading', { name: 'Unstaged (2)' }).parentElement);
    expect(screen.queryByTestId('file-counts')).toBeNull();
    expect(screen.queryAllByRole('button', { name: /^(stage|unstage|discard|commit)\b/i })).toHaveLength(0);
  });

  it('clicking a header collapses its section to the header and expands it again; the handle is only there while both are open', () => {
    setup();
    const unstagedBtn = screen.getByRole('button', { name: /Unstaged/ });
    expect(unstagedBtn).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('separator')).toBeInTheDocument();
    fireEvent.click(unstagedBtn);
    expect(unstagedBtn).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('listbox', { name: 'Unstaged' })).toBeNull();
    expect(screen.getByRole('listbox', { name: 'Staged' })).toBeInTheDocument();
    expect(screen.queryByRole('separator')).toBeNull();
    // The bar beside the button toggles too.
    fireEvent.click(screen.getByTestId('unstaged-totals'));
    expect(screen.getByRole('listbox', { name: 'Unstaged' })).toBeInTheDocument();
    expect(screen.getByRole('separator')).toBeInTheDocument();
  });

  it('the handle is keyboard-resizable within its bounds', () => {
    setup();
    const sep = screen.getByRole('separator');
    expect(sep).toHaveAttribute('aria-valuenow', '50');
    fireEvent.keyDown(sep, { key: 'ArrowDown' });
    expect(sep).toHaveAttribute('aria-valuenow', '55');
    // jsdom reports a 600 px panel: the bounds leave each section its header and about 3 rows.
    const max = sep.getAttribute('aria-valuemax')!, min = sep.getAttribute('aria-valuemin')!;
    expect(Number(max)).toBeLessThan(90);
    fireEvent.keyDown(sep, { key: 'End' });
    expect(sep).toHaveAttribute('aria-valuenow', max);
    fireEvent.keyDown(sep, { key: 'ArrowDown' });
    expect(sep).toHaveAttribute('aria-valuenow', max);
    fireEvent.keyDown(sep, { key: 'Home' });
    expect(sep).toHaveAttribute('aria-valuenow', min);
    expect(stored().ratio).toBeCloseTo(Number(min) / 100, 1);
  });

  it('bounds keep about 3 rows (and the header) for each section, even when it cannot all fit', () => {
    const [lo, hi] = wipSplitBounds(1000, 26);
    expect(lo).toBeCloseTo((WIP_PANEL.chromePx + 3 * 26) / 1000);
    expect(hi).toBeCloseTo(1 - lo);
    expect(wipSplitBounds(200, 26)).toEqual([0.5, 0.5]);
  });

  it('the split and the collapsed state persist, and a bad stored value falls back', () => {
    const { view } = setup();
    fireEvent.keyDown(screen.getByRole('separator'), { key: 'ArrowUp' });
    fireEvent.click(screen.getByRole('button', { name: /^Staged/ }));
    expect(stored()).toEqual({ ratio: 0.45, collapsed: { unstaged: false, staged: true, conflicted: false } });
    view.unmount();
    setup();
    expect(screen.getByRole('button', { name: /^Staged/ })).toHaveAttribute('aria-expanded', 'false');
    localStorage.setItem(WIP_PANEL.key, '{"ratio":"x","collapsed":7}');
    expect(loadWipPanel()).toEqual({ ratio: 0.5, collapsed: { unstaged: false, staged: false, conflicted: false } });
    localStorage.setItem(WIP_PANEL.key, 'not json');
    expect(loadWipPanel().ratio).toBe(0.5);
  });

  it('up/down run through both expanded sections as one sequence, wrapping at the overall ends', () => {
    const { store } = setup();
    const unstaged = screen.getByRole('listbox', { name: 'Unstaged' });
    act(() => unstaged.focus());
    const press = (key: string) => {
      fireEvent.keyDown(document.activeElement!, { key });
      return store.getState().diff?.path;
    };
    expect(['ArrowDown', 'ArrowDown', 'ArrowDown', 'ArrowDown'].map(press)).toEqual(['src/a.txt', 'src/b.txt', 'lib/c.txt', 'src/a.txt']);
    expect(document.activeElement).toBe(unstaged);
    expect(['ArrowUp', 'ArrowUp', 'ArrowUp'].map(press)).toEqual(['lib/c.txt', 'src/b.txt', 'src/a.txt']);
    expect(document.activeElement).toBe(unstaged);
  });

  it('a collapsed section is skipped: the other list wraps on its own', () => {
    const { store } = setup();
    fireEvent.click(screen.getByRole('button', { name: /^Staged/ }));
    const unstaged = screen.getByRole('listbox', { name: 'Unstaged' });
    act(() => unstaged.focus());
    const press = (key: string) => {
      fireEvent.keyDown(unstaged, { key });
      return store.getState().diff?.path;
    };
    expect(['ArrowDown', 'ArrowDown', 'ArrowDown', 'ArrowUp'].map(press)).toEqual(['src/a.txt', 'src/b.txt', 'src/a.txt', 'src/b.txt']);
    expect(screen.queryByRole('listbox', { name: 'Staged' })).toBeNull();
  });

  it('collapsing a section keeps its folder state and keyboard cursor', () => {
    setup();
    fireEvent.click(screen.getByRole('button', { name: 'Tree' }));
    const unstaged = screen.getByRole('tree', { name: 'Unstaged' });
    fireEvent.mouseDown(screen.getAllByRole('treeitem').find((o) => o.getAttribute('data-path') === 'src')!); // collapse the folder
    expect(within(unstaged).getAllByRole('treeitem')).toHaveLength(1);
    act(() => unstaged.focus());
    fireEvent.keyDown(unstaged, { key: 'ArrowDown' }); // only folder row: cursor stays on it
    fireEvent.click(screen.getByRole('button', { name: /Unstaged/ }));
    expect(screen.queryByRole('tree', { name: 'Unstaged' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Unstaged/ }));
    const back = screen.getByRole('tree', { name: 'Unstaged' });
    expect(within(back).getAllByRole('treeitem')).toHaveLength(1);
    expect(within(back).getByRole('treeitem')).toHaveAttribute('aria-expanded', 'false');
  });

  it('the cursor survives too: the row it was on is still the active one', () => {
    setup();
    const unstaged = screen.getByRole('listbox', { name: 'Unstaged' });
    act(() => unstaged.focus());
    fireEvent.keyDown(unstaged, { key: 'ArrowDown' });
    fireEvent.keyDown(unstaged, { key: 'ArrowDown' });
    const active = () => within(screen.getByRole('listbox', { name: 'Unstaged' })).getByRole('option', { selected: true }).getAttribute('data-path');
    expect(active()).toBe('src/b.txt');
    fireEvent.click(screen.getByRole('button', { name: /Unstaged/ }));
    fireEvent.click(screen.getByRole('button', { name: /Unstaged/ }));
    expect(active()).toBe('src/b.txt');
  });
});

describe('WipSections split double-click (K73)', () => {
  it('resets the Unstaged/Staged split to 50% and persists it', () => {
    localStorage.setItem(WIP_PANEL.key, JSON.stringify({ ratio: 0.3, collapsed: { unstaged: false, staged: false } }));
    setup();
    fireEvent.doubleClick(screen.getByRole('separator', { name: 'Resize unstaged and staged files' }));
    expect(stored().ratio).toBe(0.5);
  });
});
