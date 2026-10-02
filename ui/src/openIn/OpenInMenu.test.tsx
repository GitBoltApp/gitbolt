import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OpenerPayload } from '../api/gen/OpenerPayload';
import type { GraphPayload } from '../api/gen/GraphPayload';
import { ContextMenu } from '../menu/ContextMenu';
import { createRepoViewStore, RepoViewContext, type DiffTarget } from '../repo/store';
import { fakeServices } from '../repo/testServices';
import { TooltipHost } from '../ui/TooltipHost';
import { useToast } from '../ui/toast';

const OPENERS: OpenerPayload[] = [
  { id: 'jetbrains-phpstorm', name: 'PhpStorm', kind: 'editor' },
  { id: 'vscode', name: 'VS Code', kind: 'editor' },
  { id: 'file-manager', name: 'Files', kind: 'fileManager' },
  { id: 'other', name: 'Other…', kind: 'chooser' },
];
const listOpeners = vi.hoisted(() => vi.fn(async (): Promise<OpenerPayload[]> => []));
const openIn = vi.hoisted(() => vi.fn(async (_repo: number, _r: unknown): Promise<null> => null));
vi.mock('../api/client', () => ({ api: { listOpeners, openIn }, errorMessage: (e: { message: string }) => e.message }));

const { OpenInButton } = await import('./OpenInMenu');
const { resetOpenersForTests, defaultOpener, worktreeOf, openVersion, listWorktree } = await import('./openers');
const { filesKey } = await import('../repo/services');
const { OPEN_IN_KEY, loadLastOpener } = await import('./openInPrefs');

const graph: GraphPayload = { rows: [], labels: [], maxLanes: 0, pinnedRef: null, head: { branch: null, target: null, detached: false, unborn: true }, truncated: false, worktrees: [] };
const commitTarget: DiffTarget = { key: 'k|src/app.php', path: 'src/app.php', oldPath: null, status: 'M', old: { kind: 'object', oid: 'a'.repeat(40) }, new: { kind: 'object', oid: 'b'.repeat(40) }, view: 'diff' };

function renderButton(target: DiffTarget = commitTarget, line: number | null = null) {
  const store = createRepoViewStore(7, '/repo', graph, fakeServices());
  return render(<RepoViewContext value={store}><OpenInButton target={target} line={line} /><ContextMenu /><TooltipHost /></RepoViewContext>);
}

beforeEach(() => {
  localStorage.clear();
  resetOpenersForTests();
  listOpeners.mockReset().mockResolvedValue(OPENERS);
  openIn.mockReset().mockResolvedValue(null);
});
afterEach(cleanup);

describe('defaultOpener and worktreeOf', () => {
  it('prefers the last used, then VS Code, then the first editor, then anything', () => {
    expect(defaultOpener(OPENERS, 'file-manager')?.id).toBe('file-manager');
    expect(defaultOpener(OPENERS, 'gone')?.id).toBe('vscode');
    expect(defaultOpener(OPENERS.filter((o) => o.id !== 'vscode'), null)?.id).toBe('jetbrains-phpstorm');
    expect(defaultOpener([OPENERS[2]], null)?.id).toBe('file-manager');
    expect(defaultOpener([], null)).toBeNull();
    // H32: "Other…" is the default only when it was the last used.
    expect(defaultOpener([OPENERS[3], OPENERS[2]], null)?.id).toBe('file-manager');
    expect(defaultOpener([OPENERS[3]], null)?.id).toBe('other');
    expect(defaultOpener(OPENERS, 'other')?.id).toBe('other');
  });

  it('a worktree side names the worktree; a commit file has none (the caller uses the repo)', () => {
    expect(worktreeOf(commitTarget)).toBeNull();
    expect(worktreeOf({ ...commitTarget, new: { kind: 'worktree', worktree: '/wt' } })).toBe('/wt');
    expect(worktreeOf({ ...commitTarget, old: { kind: 'worktree', worktree: '/wt2' }, new: { kind: 'absent' } })).toBe('/wt2');
  });
});

describe('openVersion and listWorktree (fix rounds 1, 2)', () => {
  it('outside a worktree: the version shown, the new side, else (deleted) the old', () => {
    const old = { kind: 'object', oid: 'a'.repeat(40) } as const;
    expect(openVersion(commitTarget, null)).toEqual({ source: commitTarget.new, fallback: null });
    expect(openVersion({ ...commitTarget, new: { kind: 'absent' } }, null)).toEqual({ source: old, fallback: null });
    expect(openVersion({ ...commitTarget, new: { kind: 'atCommit', commit: 'c'.repeat(40) } }, null).source).toEqual({ kind: 'atCommit', commit: 'c'.repeat(40) });
  });

  it('in a worktree list (WIP unstaged or staged): the working-tree file, the list\'s stored version as the fallback', () => {
    const worktree = { kind: 'worktree', worktree: '/wt' } as const;
    // Staged: the index blob is the new side.
    expect(openVersion(commitTarget, '/wt')).toEqual({ source: worktree, fallback: commitTarget.new });
    // Unstaged: the working tree is the new side, the index the old.
    expect(openVersion({ ...commitTarget, new: worktree }, '/wt')).toEqual({ source: worktree, fallback: commitTarget.old });
    // Deleted in the working tree: its index version.
    expect(openVersion({ ...commitTarget, new: { kind: 'absent' } }, '/wt')).toEqual({ source: worktree, fallback: commitTarget.old });
  });

  it('the list a target belongs to gives its worktree (a staged file has no worktree side)', () => {
    const staged = { kind: 'wip', worktree: '/wt/a|b}c', staged: true } as const;
    expect(listWorktree(`${filesKey(staged)}|src/app.php`)).toBe('/wt/a|b}c');
    expect(listWorktree(`${filesKey({ kind: 'worktree', from: 'c'.repeat(40), worktree: '/wt2' })}|x`)).toBe('/wt2');
    expect(listWorktree(`${filesKey({ kind: 'commit', id: 'c'.repeat(40), parent: 0 })}|x`)).toBeNull();
    expect(listWorktree('garbage')).toBeNull();
  });
});

describe('OpenInButton', () => {
  it('opens the file in the default opener (VS Code), at the line, in the repo worktree', async () => {
    renderButton(commitTarget, 12);
    const main = await screen.findByRole('button', { name: 'Open in VS Code' });
    fireEvent.click(main);
    await waitFor(() => expect(openIn).toHaveBeenCalledExactlyOnceWith(7, { worktree: '/repo', path: 'src/app.php', line: 12, opener: 'vscode', source: { kind: 'object', oid: 'b'.repeat(40) }, fallback: null }));
    expect(loadLastOpener()).toBe('vscode');
  });

  it('the dropdown lists every opener, through the shared context menu, and remembers the one picked', async () => {
    renderButton({ ...commitTarget, new: { kind: 'worktree', worktree: '/wt' } });
    const toggle = await screen.findByRole('button', { name: 'More ways to open' });
    expect(toggle).toHaveAttribute('aria-haspopup', 'menu');
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(toggle);
    const menu = screen.getByTestId('context-menu');
    // Named for what it is (1B's popup was too), not the shared menu's generic "Context menu".
    expect(screen.getByRole('menu', { name: 'Open in' })).toBe(menu);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    const items = screen.getAllByRole('menuitem');
    expect(items.map((i) => i.textContent)).toEqual(['Open in PhpStorm', 'Open in VS Code', 'Show in Files', 'Other…']);
    // Focus starts on the current default (`openMenuAt`'s `initial`); arrows move and wrap.
    expect(menu.querySelector('[data-active="true"]')).toHaveTextContent('Open in VS Code');
    fireEvent.keyDown(menu, { key: 'ArrowDown' });
    expect(menu.querySelector('[data-active="true"]')).toHaveTextContent('Show in Files');
    fireEvent.keyDown(menu, { key: 'ArrowDown' });
    fireEvent.keyDown(menu, { key: 'ArrowDown' });
    expect(menu.querySelector('[data-active="true"]')).toHaveTextContent('Open in PhpStorm');
    fireEvent.keyDown(menu, { key: 'End' });
    expect(menu.querySelector('[data-active="true"]')).toHaveTextContent('Other…');
    fireEvent.keyDown(menu, { key: 'Home' });
    expect(menu.querySelector('[data-active="true"]')).toHaveTextContent('Open in PhpStorm');
    fireEvent.keyDown(menu, { key: 'Enter' });
    expect(screen.queryByTestId('context-menu')).not.toBeVisible();
    await waitFor(() => expect(openIn).toHaveBeenCalledExactlyOnceWith(7, { worktree: '/wt', path: 'src/app.php', line: null, opener: 'jetbrains-phpstorm', source: { kind: 'worktree', worktree: '/wt' }, fallback: { kind: 'object', oid: 'a'.repeat(40) } }));
    expect(JSON.parse(localStorage.getItem(OPEN_IN_KEY)!)).toEqual({ last: 'jetbrains-phpstorm' });
    // The main button now shows the last used.
    expect(screen.getByRole('button', { name: 'Open in PhpStorm' })).toBeInTheDocument();
  });

  it('Escape closes the dropdown and returns focus to its toggle; a click outside closes it', async () => {
    renderButton();
    const toggle = await screen.findByRole('button', { name: 'More ways to open' });
    // A real click focuses a button first (jsdom's `fireEvent.click` doesn't emulate that default
    // action): the menu's own focus-restore (`ContextMenu`'s `returnTo`) reads whatever had focus
    // when it opened.
    act(() => toggle.focus());
    fireEvent.click(toggle);
    fireEvent.keyDown(screen.getByTestId('context-menu'), { key: 'Escape' });
    expect(screen.getByTestId('context-menu')).not.toBeVisible();
    expect(toggle).toHaveFocus();
    fireEvent.click(toggle);
    expect(screen.getByTestId('context-menu')).toBeVisible();
    fireEvent.pointerDown(document.body);
    expect(screen.getByTestId('context-menu')).not.toBeVisible();
    expect(openIn).not.toHaveBeenCalled();
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
  });

  // K1: a scroll doesn't close the shared context menu (menu/ContextMenu.tsx), so the dropdown
  // keeps that guarantee too now that it's the same menu.
  it('a scroll does not close the dropdown; the wheel outside it is swallowed only while it is open (K1)', async () => {
    renderButton();
    const toggle = await screen.findByRole('button', { name: 'More ways to open' });
    fireEvent.click(toggle);
    fireEvent.scroll(window);
    fireEvent.scroll(document.body);
    expect(screen.getByTestId('context-menu')).toBeVisible();
    const behind = vi.fn();
    document.body.addEventListener('wheel', behind);
    const wheel = (target: EventTarget) => {
      const e = new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: 100 });
      target.dispatchEvent(e);
      return e.defaultPrevented;
    };
    expect(wheel(document.body)).toBe(true);
    expect(behind).not.toHaveBeenCalled();
    fireEvent.keyDown(screen.getByTestId('context-menu'), { key: 'Escape' });
    expect(screen.getByTestId('context-menu')).not.toBeVisible();
    behind.mockClear();
    expect(wheel(document.body)).toBe(false);
    expect(behind).toHaveBeenCalledOnce();
    document.body.removeEventListener('wheel', behind);
  });

  it('a resize closes the dropdown and restores focus to its toggle (I2)', async () => {
    renderButton();
    const toggle = await screen.findByRole('button', { name: 'More ways to open' });
    act(() => toggle.focus());
    fireEvent.click(toggle);
    expect(screen.getByTestId('context-menu')).toBeVisible();
    fireEvent.resize(window);
    expect(screen.getByTestId('context-menu')).not.toBeVisible();
    expect(toggle).toHaveFocus();
  });

  it('a staged WIP file opens its working-tree file in the list\'s worktree, and Show in Files uses it too (fix round 2)', async () => {
    const staged = { ...commitTarget, key: `${filesKey({ kind: 'wip', worktree: '/wt/linked', staged: true })}|src/app.php` };
    renderButton(staged, 4);
    fireEvent.click(await screen.findByRole('button', { name: 'Open in VS Code' }));
    await waitFor(() => expect(openIn).toHaveBeenLastCalledWith(7, { worktree: '/wt/linked', path: 'src/app.php', line: 4, opener: 'vscode', source: { kind: 'worktree', worktree: '/wt/linked' }, fallback: staged.new }));
    fireEvent.click(screen.getByRole('button', { name: 'More ways to open' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Show in Files' }));
    await waitFor(() => expect(openIn).toHaveBeenLastCalledWith(7, expect.objectContaining({ worktree: '/wt/linked', opener: 'file-manager' })));
  });

  it('a failed open shows the error', async () => {
    openIn.mockRejectedValueOnce({ message: 'src/app.php isn\'t in the working tree' });
    renderButton();
    fireEvent.click(await screen.findByRole('button', { name: 'Open in VS Code' }));
    await waitFor(() => expect(useToast.getState().message).toBe('src/app.php isn\'t in the working tree'));
  });

  it('opening the dropdown re-detects, so an editor installed since shows up live, with no close/reopen (H32; fix round 1, item 2)', async () => {
    renderButton();
    const toggle = await screen.findByRole('button', { name: 'More ways to open' });
    expect(listOpeners).toHaveBeenCalledTimes(1);
    listOpeners.mockResolvedValueOnce([...OPENERS.slice(0, 2), { id: 'zed', name: 'Zed', kind: 'editor' }, ...OPENERS.slice(2)]);
    fireEvent.click(toggle);
    expect(screen.getByTestId('context-menu')).toBeVisible();
    await waitFor(() => expect(listOpeners).toHaveBeenCalledTimes(2));
    // The re-detection's result appears in the still-open dropdown (`openMenuAt`'s `build`
    // rebuilds from the live `openersSnapshot()`, same as the file menu's Open in ▸ submenu).
    expect(await screen.findByRole('menuitem', { name: 'Open in Zed' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Other…' }));
    await waitFor(() => expect(openIn).toHaveBeenCalledExactlyOnceWith(7, { worktree: '/repo', path: 'src/app.php', line: null, opener: 'other', source: { kind: 'object', oid: 'b'.repeat(40) }, fallback: null }));
  });

  it('a press on the toggle while its dropdown is open closes it, instead of reopening it (fix round 1, item 3)', async () => {
    renderButton();
    const toggle = await screen.findByRole('button', { name: 'More ways to open' });
    fireEvent.click(toggle);
    expect(screen.getByTestId('context-menu')).toBeVisible();
    // A real press: pointerdown (which the menu's own outside-press handling already closes the
    // menu from) then click — `wasOpen` must still say "it was open" despite that.
    fireEvent.pointerDown(toggle);
    fireEvent.click(toggle);
    expect(screen.getByTestId('context-menu')).not.toBeVisible();
  });

  it('renders nothing when no opener was found', async () => {
    listOpeners.mockResolvedValue([]);
    renderButton();
    await act(async () => {});
    expect(listOpeners).toHaveBeenCalled();
    expect(screen.queryByRole('group', { name: 'Open in' })).toBeNull();
  });
});
