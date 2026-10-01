import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FileChange } from '../api/gen/FileChange';
import type { GraphPayload } from '../api/gen/GraphPayload';
import { createRepoViewStore, RepoViewContext } from '../repo/store';
import { fakeServices } from '../repo/testServices';
import { DEFAULT_DENSITY, useDensity } from '../theme/density';
import { FileList } from './FileList';
import { useFileListPrefs } from './fileListPrefs';

// A row draws its status icon with `decorative` unset; counting those draws counts row renders.
const rowDraws: string[] = [];
vi.mock('./StatusIcon', async (orig) => {
  const real = await orig<typeof import('./StatusIcon')>();
  return {
    ...real,
    StatusIcon: (p: Parameters<typeof real.StatusIcon>[0]) => {
      if (!p.decorative) rowDraws.push(p.status);
      return real.StatusIcon(p);
    },
  };
});

const change = (path: string, status = 'M'): FileChange => ({
  path, oldPath: null, status, additions: 2, deletions: 1,
  old: { kind: 'object', oid: 'a'.repeat(40) }, new: { kind: 'object', oid: 'b'.repeat(40) }, submodule: false,
});
const list = { files: [change('a.txt', 'A'), change('b.txt', 'D'), change('c.txt', 'M'), change('src/d.txt', 'M')], added: 4, deleted: 2 };
const spec = { kind: 'commit' as const, id: 'c'.repeat(40), parent: 0 };
const graph: GraphPayload = { rows: [], labels: [], maxLanes: 0, pinnedRef: null, head: { branch: null, target: null, detached: false, unborn: true }, truncated: false };

function setup() {
  const store = createRepoViewStore(1, '/r', graph, fakeServices());
  render(<RepoViewContext value={store}><FileList list={list} spec={spec} label="Changed files" /></RepoViewContext>);
  return store;
}

describe('FileList rows', () => {
  beforeEach(() => {
    useDensity.setState({ density: DEFAULT_DENSITY });
    rowDraws.length = 0;
  });
  afterEach(cleanup);

  it('M2: moving the cursor re-renders only the rows whose active state changed', () => {
    useFileListPrefs.getState().set({ mode: 'path', sort: 'path', allFiles: false });
    setup();
    const box = screen.getByRole('listbox');
    fireEvent.keyDown(box, { key: 'ArrowDown' }); // opens a.txt
    rowDraws.length = 0;
    fireEvent.keyDown(box, { key: 'ArrowDown' }); // a.txt -> b.txt
    // Only a.txt (loses the highlight) and b.txt (gains it) draw again; c.txt and d.txt don't.
    expect(rowDraws.sort()).toEqual(['A', 'D']);
  });

  it('M12: a handled key while the panel is pending is swallowed (the list does not scroll), and opens nothing', () => {
    useFileListPrefs.getState().set({ mode: 'path', sort: 'path', allFiles: false });
    const store = setup();
    store.setState({ panelPending: true });
    const box = screen.getByRole('listbox');
    for (const key of ['ArrowDown', 'ArrowUp', 'PageDown', 'PageUp', 'Home', 'End', 'ArrowLeft', 'ArrowRight', 'Enter', ' ']) {
      const ev = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
      box.dispatchEvent(ev);
      expect(ev.defaultPrevented, key).toBe(true);
    }
    expect(store.getState().diff).toBeNull();
    // Keys the list does not handle stay the browser's (Tab moves focus on).
    const tab = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
    box.dispatchEvent(tab);
    expect(tab.defaultPrevented).toBe(false);
  });

  it('M8: tree mode is a tree of treeitems with aria-level and aria-expanded on folders; path mode stays a listbox', () => {
    useFileListPrefs.getState().set({ mode: 'tree', sort: 'path', allFiles: false });
    setup();
    expect(screen.getByRole('tree', { name: 'Changed files' })).toBeInTheDocument();
    expect(screen.queryByRole('listbox')).toBeNull();
    const items = screen.getAllByRole('treeitem');
    const src = items.find((i) => i.dataset.path === 'src')!;
    expect(src).toHaveAttribute('aria-expanded', 'true');
    expect(src).toHaveAttribute('aria-level', '1');
    const nested = items.find((i) => i.dataset.path === 'src/d.txt')!;
    expect(nested).toHaveAttribute('aria-level', '2');
    expect(nested).not.toHaveAttribute('aria-expanded');
    expect(items.find((i) => i.dataset.path === 'a.txt')).toHaveAttribute('aria-level', '1');
    cleanup();
    useFileListPrefs.getState().set({ mode: 'path' });
    setup();
    expect(screen.getByRole('listbox', { name: 'Changed files' })).toBeInTheDocument();
    for (const o of screen.getAllByRole('option')) expect(o).not.toHaveAttribute('aria-expanded');
  });
});
