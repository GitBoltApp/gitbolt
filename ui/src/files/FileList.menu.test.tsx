import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DiffSpec } from '../api/gen/DiffSpec';
import type { FileChange } from '../api/gen/FileChange';
import type { GraphPayload } from '../api/gen/GraphPayload';
import type { OpenerPayload } from '../api/gen/OpenerPayload';
import type { RemotePayload } from '../api/gen/RemotePayload';
import { createRepoViewStore, RepoViewContext } from '../repo/store';
import { fakeServices } from '../repo/testServices';

const OPENERS: OpenerPayload[] = [
  { id: 'vscode', name: 'VS Code', kind: 'editor' },
  { id: 'file-manager', name: 'Files', kind: 'fileManager' },
  { id: 'other', name: 'Other…', kind: 'chooser' },
];
const listOpeners = vi.hoisted(() => vi.fn(async (): Promise<OpenerPayload[]> => []));
const openIn = vi.hoisted(() => vi.fn(async (_repo: number, _r: unknown): Promise<null> => null));
const openUrl = vi.hoisted(() => vi.fn(async (_url: string): Promise<null> => null));
const copyText = vi.hoisted(() => vi.fn(async (_text: string): Promise<void> => {}));
vi.mock('../api/client', async (orig) => ({ ...(await orig<typeof import('../api/client')>()), api: { listOpeners, openIn, openUrl } }));
vi.mock('../api/transport', async (orig) => ({ ...(await orig<typeof import('../api/transport')>()), copyText }));

const { FileList } = await import('./FileList');
const { useFileListPrefs } = await import('./fileListPrefs');
const { resetOpenersForTests } = await import('../openIn/openers');
const { ContextMenu } = await import('../menu/ContextMenu');
const { useMenu } = await import('../menu/menuStore');
const { TooltipHost } = await import('../ui/TooltipHost');
const { Toast } = await import('../ui/Toast');

const change = (path: string): FileChange => ({ path, oldPath: null, status: 'M', additions: 1, deletions: 1, old: { kind: 'object', oid: 'a'.repeat(40) }, new: { kind: 'object', oid: 'b'.repeat(40) }, submodule: false });
const list = { files: [change('README.md'), change('src/app.php')], added: 2, deleted: 2 };
const graph: GraphPayload = { rows: [], labels: [], maxLanes: 0, pinnedRef: null, head: { branch: null, target: null, detached: false, unborn: true }, truncated: false };
const GITLAB: RemotePayload[] = [{ name: 'origin', host: 'gitlab.example.com', path: 'acme/shop', hostKind: 'gitlab' }];
const COMMIT = 'c'.repeat(40);

function setup(spec: DiffSpec = { kind: 'commit', id: COMMIT, parent: 0 }, remotes: RemotePayload[] = []) {
  const store = createRepoViewStore(3, '/repo', graph, fakeServices({ remotes: async () => remotes }));
  render(<RepoViewContext value={store}><FileList list={list} spec={spec} label="Changed files" /><ContextMenu /><TooltipHost /><Toast /></RepoViewContext>);
  return store;
}
const row = (path: string) => rowEls().find((r) => r.dataset.path === path)!;
const menu = () => screen.getByTestId('context-menu');
const item = (name: string | RegExp) => screen.getByRole('menuitem', { name });
const topLabels = () => [...menu().querySelectorAll('[data-depth="0"] > [role="menuitem"] .ctx-label')].map((e) => e.textContent);
const openSubmenu = () => fireEvent.click(item('Open in'));
const subLabels = () => [...menu().querySelectorAll('[data-depth="1"] [role="menuitem"]')].map((e) => e.textContent);

beforeEach(() => {
  localStorage.clear();
  resetOpenersForTests();
  listOpeners.mockReset().mockResolvedValue(OPENERS);
  openIn.mockReset().mockResolvedValue(null);
  openUrl.mockReset().mockResolvedValue(null);
  copyText.mockReset().mockResolvedValue(undefined);
  useFileListPrefs.getState().set({ mode: 'path', sort: 'path', allFiles: false });
});
afterEach(async () => {
  act(() => useMenu.getState().close());
  // Let each menu's after-paint work (the openers' re-detection) run inside its own test.
  // Queued behind it: `afterPaint` is a frame, then a 0 ms timer, so this lands after it.
  await act(() => new Promise<void>((r) => requestAnimationFrame(() => setTimeout(r, 0))));
  cleanup();
});

/** The rows and the list, whatever their roles: tree mode is a `tree` of `treeitem`s (M8), path mode a `listbox` of `option`s. */
const rowEls = () => [...document.querySelectorAll<HTMLElement>('[role="option"], [role="treeitem"]')];
const listEl = () => document.querySelector<HTMLElement>('.file-list-scroll')!;

describe('the file row context menu (spec §7 file menu)', () => {
  it('right-click opens the shared menu at the pointer, without opening the file', async () => {
    const store = setup();
    await act(async () => {});
    fireEvent.contextMenu(row('src/app.php'), { clientX: 30, clientY: 40 });
    expect(menu()).toBeVisible();
    expect(useMenu.getState()).toMatchObject({ x: 30, y: 40 });
    expect(store.getState().diff).toBeNull();
    // No forge row: the repo has no GitLab/GitHub remote.
    expect(topLabels()).toEqual(['Copy path', 'Open in', 'View']);
    // H32: every opening re-detects (the backend caches briefly).
    await waitFor(() => expect(listOpeners).toHaveBeenCalledTimes(2));
  });

  it('Copy path: Rel and Abs put the paths on the clipboard', async () => {
    setup();
    await act(async () => {});
    fireEvent.contextMenu(row('src/app.php'));
    fireEvent.click(screen.getByRole('button', { name: /absolute path/ }));
    await waitFor(() => expect(copyText).toHaveBeenLastCalledWith('/repo/src/app.php'));
    expect(await screen.findByRole('status')).toHaveTextContent('Copied');
    expect(menu()).not.toBeVisible();
    fireEvent.contextMenu(row('src/app.php'));
    fireEvent.click(screen.getByRole('button', { name: /repository-relative path/ }));
    await waitFor(() => expect(copyText).toHaveBeenLastCalledWith('src/app.php'));
  });

  it("Forge link, once the remotes are known: copies the commit's permalink, Open opens it", async () => {
    setup(undefined, GITLAB);
    await act(async () => {});
    fireEvent.contextMenu(row('src/app.php'));
    expect(topLabels()).toEqual(['Copy path', 'Forge link', 'Open in', 'View']);
    const permalink = `https://gitlab.example.com/acme/shop/-/blob/${COMMIT}/src/app.php`;
    fireEvent.click(screen.getByText('Forge link'));
    await waitFor(() => expect(copyText).toHaveBeenLastCalledWith(permalink));
    fireEvent.contextMenu(row('src/app.php'));
    fireEvent.click(screen.getByRole('button', { name: /^Open .* in the browser/ }));
    expect(openUrl).toHaveBeenLastCalledWith(permalink);
  });

  it('Open in ▸ lists the openers; a pick opens the file; the last used starts active next time', async () => {
    setup();
    await act(async () => {});
    fireEvent.contextMenu(row('src/app.php'));
    openSubmenu();
    expect(subLabels()).toEqual(['Open in VS Code', 'Show in Files', 'Other…']);
    expect(screen.getByRole('menu', { name: 'Open in' })).toBeVisible();
    fireEvent.click(item('Show in Files'));
    expect(menu()).not.toBeVisible();
    await waitFor(() => expect(openIn).toHaveBeenCalledExactlyOnceWith(3, { worktree: '/repo', path: 'src/app.php', line: null, opener: 'file-manager', source: { kind: 'object', oid: 'b'.repeat(40) }, fallback: null }));
    fireEvent.contextMenu(row('README.md'));
    fireEvent.keyDown(menu(), { key: 'ArrowDown' });
    fireEvent.keyDown(menu(), { key: 'ArrowRight' });
    expect(menu().querySelector('[data-depth="1"] [data-active="true"]')).toHaveAttribute('data-row-id', 'opener.file-manager');
  });

  it('a staged WIP file opens its working-tree file, the index blob as the fallback (fix round 2)', async () => {
    setup({ kind: 'wip', worktree: '/wt/feature', staged: true });
    await act(async () => {});
    fireEvent.contextMenu(row('src/app.php'));
    openSubmenu();
    fireEvent.click(item('Open in VS Code'));
    await waitFor(() => expect(openIn).toHaveBeenCalledExactlyOnceWith(3, { worktree: '/wt/feature', path: 'src/app.php', line: null, opener: 'vscode', source: { kind: 'worktree', worktree: '/wt/feature' }, fallback: { kind: 'object', oid: 'b'.repeat(40) } }));
  });

  it('a WIP file: its own worktree, Abs under it, and "View file"', async () => {
    setup({ kind: 'wip', worktree: '/wt/feature', staged: false });
    await act(async () => {});
    fireEvent.contextMenu(row('README.md'));
    expect(topLabels()).toEqual(['Copy path', 'Open in', 'View']);
    fireEvent.click(screen.getByRole('button', { name: /absolute path/ }));
    await waitFor(() => expect(copyText).toHaveBeenLastCalledWith('/wt/feature/README.md'));
    fireEvent.contextMenu(row('README.md'));
    openSubmenu();
    fireEvent.click(item('Open in VS Code'));
    await waitFor(() => expect(openIn).toHaveBeenCalledExactlyOnceWith(3, { worktree: '/wt/feature', path: 'README.md', line: null, opener: 'vscode', source: { kind: 'worktree', worktree: '/wt/feature' }, fallback: { kind: 'object', oid: 'b'.repeat(40) } }));
  });

  it('View: the label opens the diff, the File variant the whole file (K58)', async () => {
    const store = setup();
    await act(async () => {});
    const variant = (id: string) => menu().querySelector(`[data-depth="0"] .ctx-variant[data-variant-id="${id}"]`)!;
    fireEvent.contextMenu(row('src/app.php'));
    fireEvent.click(item('View'));
    expect(store.getState().diff).toMatchObject({ path: 'src/app.php', view: 'diff' });
    fireEvent.contextMenu(row('README.md'));
    fireEvent.click(variant('file'));
    expect(store.getState().diff).toMatchObject({ path: 'README.md', view: 'file' });
    fireEvent.contextMenu(row('src/app.php'));
    fireEvent.click(variant('diff'));
    expect(store.getState().diff).toMatchObject({ path: 'src/app.php', view: 'diff' });
  });

  it('the keyboard: Shift+F10 or the menu key opens it at the active row; Escape closes it and gives the list its focus back', async () => {
    const store = setup();
    await act(async () => {});
    const box = listEl();
    box.focus();
    fireEvent.mouseDown(row('src/app.php'));
    fireEvent.keyDown(box, { key: 'F10', shiftKey: true });
    expect(menu()).toBeVisible();
    expect(menu()).toHaveFocus();
    // Arrow keys move in the menu, not the file list.
    fireEvent.keyDown(menu(), { key: 'ArrowDown' });
    expect(store.getState().diff?.path).toBe('src/app.php');
    fireEvent.keyDown(menu(), { key: 'Escape' });
    expect(menu()).not.toBeVisible();
    expect(box).toHaveFocus();
    expect(store.getState().diff?.path).toBe('src/app.php');
    fireEvent.keyDown(box, { key: 'ContextMenu' });
    expect(menu()).toBeVisible();
  });

  it('a folder row has its own menu (the native one suppressed): Copy path, and Open in ▸ Files', async () => {
    useFileListPrefs.getState().set({ mode: 'tree', sort: 'path', allFiles: false });
    setup({ kind: 'wip', worktree: '/wt/feature', staged: false });
    await act(async () => {});
    const folder = rowEls().find((r) => r.dataset.kind === 'folder')!;
    const e = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 4, clientY: 4 });
    act(() => { folder.dispatchEvent(e); });
    expect(e.defaultPrevented).toBe(true);
    expect(topLabels()).toEqual(['Copy path', 'Open in']);
    fireEvent.click(screen.getByRole('button', { name: /absolute path/ }));
    await waitFor(() => expect(copyText).toHaveBeenLastCalledWith('/wt/feature/src'));
    fireEvent.contextMenu(folder);
    openSubmenu();
    expect(subLabels()).toEqual(['Show in Files']);
    fireEvent.click(item('Show in Files'));
    // The file manager shows the folder of the path it's given: a file inside the folder.
    await waitFor(() => expect(openIn).toHaveBeenCalledExactlyOnceWith(3, { worktree: '/wt/feature', path: 'src/app.php', line: null, opener: 'file-manager', source: null, fallback: null }));
  });

  it('the Forge row appears in an open menu once the remotes arrive', async () => {
    let answer: (r: RemotePayload[]) => void = () => {};
    const remotes = new Promise<RemotePayload[]>((r) => { answer = r; });
    const store = createRepoViewStore(3, '/repo', graph, fakeServices({ remotes: () => remotes }));
    render(<RepoViewContext value={store}><FileList list={list} spec={{ kind: 'commit', id: COMMIT, parent: 0 }} label="Changed files" /><ContextMenu /><TooltipHost /></RepoViewContext>);
    await act(async () => {});
    fireEvent.contextMenu(row('src/app.php'));
    expect(topLabels()).not.toContain('Forge link');
    await act(async () => answer(GITLAB));
    expect(topLabels()).toContain('Forge link');
  });

  it('re-detects the openers only after the menu has painted (no backend call before it shows)', async () => {
    setup();
    await act(async () => {});
    await waitFor(() => expect(listOpeners).toHaveBeenCalled());
    const before = listOpeners.mock.calls.length;
    fireEvent.contextMenu(row('src/app.php'));
    expect(menu()).toBeVisible();
    expect(listOpeners).toHaveBeenCalledTimes(before);
    await waitFor(() => expect(listOpeners).toHaveBeenCalledTimes(before + 1));
  });

  it('a right-click before the openers load opens the menu at once, then fills the submenu (fix round 1)', async () => {
    let answer: (l: OpenerPayload[]) => void = () => {};
    listOpeners.mockReset().mockImplementation(() => new Promise((r) => { answer = r; }));
    setup();
    fireEvent.contextMenu(row('README.md'), { clientX: 5, clientY: 5 });
    expect(menu()).toHaveFocus();
    openSubmenu();
    expect(subLabels()).toEqual(['Looking for editors…']);
    await waitFor(() => expect(listOpeners).toHaveBeenCalled());
    await act(async () => answer(OPENERS));
    expect(subLabels()).toEqual(['Open in VS Code', 'Show in Files', 'Other…']);
  });

  it('a failed load shows an error row, and the next opening retries', async () => {
    listOpeners.mockReset().mockRejectedValue({ message: 'no session bus' });
    setup();
    await act(async () => {});
    fireEvent.contextMenu(row('README.md'));
    openSubmenu();
    await waitFor(() => expect(subLabels()).toEqual(["Couldn't list editors"]));
    fireEvent.pointerEnter(item("Couldn't list editors"));
    expect(screen.getByRole('tooltip')).toHaveTextContent("Couldn't list editors: no session bus");
    fireEvent.keyDown(menu(), { key: 'Escape' });
    listOpeners.mockResolvedValue(OPENERS);
    fireEvent.contextMenu(row('README.md'));
    openSubmenu();
    await waitFor(() => expect(subLabels()).toEqual(['Open in VS Code', 'Show in Files', 'Other…']));
  });

  it('with no opener found, the submenu says so', async () => {
    listOpeners.mockResolvedValue([]);
    setup();
    await act(async () => {});
    fireEvent.contextMenu(row('README.md'));
    openSubmenu();
    expect(subLabels()).toEqual(['No editor or file manager found']);
  });
});
