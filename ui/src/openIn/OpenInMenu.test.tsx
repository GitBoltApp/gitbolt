import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OpenerPayload } from '../api/gen/OpenerPayload';
import type { GraphPayload } from '../api/gen/GraphPayload';
import { createRepoViewStore, RepoViewContext, type DiffTarget } from '../repo/store';
import { fakeServices } from '../repo/testServices';
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

const { OpenInButton, OpenInMenu } = await import('./OpenInMenu');
const { resetOpenersForTests, defaultOpener, worktreeOf, openVersion, listWorktree } = await import('./openers');
const { filesKey } = await import('../repo/services');
const { OPEN_IN_KEY, loadLastOpener } = await import('./openInPrefs');

const graph: GraphPayload = { rows: [], labels: [], maxLanes: 0, pinnedRef: null, head: { branch: null, target: null, detached: false, unborn: true }, truncated: false };
const commitTarget: DiffTarget = { key: 'k|src/app.php', path: 'src/app.php', oldPath: null, status: 'M', old: { kind: 'object', oid: 'a'.repeat(40) }, new: { kind: 'object', oid: 'b'.repeat(40) }, view: 'diff' };

function renderButton(target: DiffTarget = commitTarget, line: number | null = null) {
  const store = createRepoViewStore(7, '/repo', graph, fakeServices());
  return render(<RepoViewContext value={store}><OpenInButton target={target} line={line} /></RepoViewContext>);
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

  it('the dropdown lists every opener, is keyboard driven, and remembers the one picked', async () => {
    renderButton({ ...commitTarget, new: { kind: 'worktree', worktree: '/wt' } });
    const toggle = await screen.findByRole('button', { name: 'More ways to open' });
    expect(toggle).toHaveAttribute('aria-haspopup', 'menu');
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(toggle);
    const menu = screen.getByRole('menu', { name: 'Open in' });
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    const items = screen.getAllByRole('menuitem');
    expect(items.map((i) => i.textContent)).toEqual(['Open in PhpStorm', 'Open in VS Code', 'Show in Files', 'Other…']);
    // Focus starts on the current default; arrows move and wrap.
    expect(items[1]).toHaveFocus();
    fireEvent.keyDown(menu, { key: 'ArrowDown' });
    expect(items[2]).toHaveFocus();
    fireEvent.keyDown(menu, { key: 'ArrowDown' });
    fireEvent.keyDown(menu, { key: 'ArrowDown' });
    expect(items[0]).toHaveFocus();
    fireEvent.keyDown(menu, { key: 'End' });
    expect(items[3]).toHaveFocus();
    fireEvent.keyDown(menu, { key: 'Home' });
    expect(items[0]).toHaveFocus();
    fireEvent.click(items[0]);
    expect(screen.queryByRole('menu')).toBeNull();
    await waitFor(() => expect(openIn).toHaveBeenCalledExactlyOnceWith(7, { worktree: '/wt', path: 'src/app.php', line: null, opener: 'jetbrains-phpstorm', source: { kind: 'worktree', worktree: '/wt' }, fallback: { kind: 'object', oid: 'a'.repeat(40) } }));
    expect(JSON.parse(localStorage.getItem(OPEN_IN_KEY)!)).toEqual({ last: 'jetbrains-phpstorm' });
    // The main button now shows the last used.
    expect(screen.getByRole('button', { name: 'Open in PhpStorm' })).toBeInTheDocument();
  });

  it('Escape closes the dropdown and returns focus to its toggle; a click outside closes it', async () => {
    renderButton();
    const toggle = await screen.findByRole('button', { name: 'More ways to open' });
    fireEvent.click(toggle);
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(toggle).toHaveFocus();
    fireEvent.keyDown(toggle, { key: 'ArrowDown' });
    expect(screen.getByRole('menu')).toBeInTheDocument();
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole('menu')).toBeNull();
    expect(openIn).not.toHaveBeenCalled();
  });

  it('a scroll or a resize that dismisses the dropdown restores focus to its toggle (I2); a stray one after a pick moved focus does not steal it back', async () => {
    renderButton();
    const toggle = await screen.findByRole('button', { name: 'More ways to open' });
    fireEvent.click(toggle);
    expect(screen.getByRole('menu')).toBeInTheDocument();
    fireEvent.scroll(window);
    expect(screen.queryByRole('menu')).toBeNull();
    expect(toggle).toHaveFocus();

    fireEvent.click(toggle);
    expect(screen.getByRole('menu')).toBeInTheDocument();
    fireEvent.resize(window);
    expect(screen.queryByRole('menu')).toBeNull();
    expect(toggle).toHaveFocus();

    // Focus already moved elsewhere (not a press: e.g. a pick's own focus move already ran) by
    // the time a stray resize/scroll arrives: it's left alone, not yanked back to the toggle.
    fireEvent.click(toggle);
    const elsewhere = document.createElement('button');
    document.body.append(elsewhere);
    elsewhere.focus();
    fireEvent.resize(window);
    expect(elsewhere).toHaveFocus();
    elsewhere.remove();
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

  it('opening the dropdown re-detects, so an editor installed since shows up (H32)', async () => {
    renderButton();
    const toggle = await screen.findByRole('button', { name: 'More ways to open' });
    expect(listOpeners).toHaveBeenCalledTimes(1);
    listOpeners.mockResolvedValueOnce([...OPENERS.slice(0, 2), { id: 'zed', name: 'Zed', kind: 'editor' }, ...OPENERS.slice(2)]);
    fireEvent.click(toggle);
    await waitFor(() => expect(listOpeners).toHaveBeenCalledTimes(2));
    expect(await screen.findByRole('menuitem', { name: 'Open in Zed' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Other…' }));
    await waitFor(() => expect(openIn).toHaveBeenCalledExactlyOnceWith(7, { worktree: '/repo', path: 'src/app.php', line: null, opener: 'other', source: { kind: 'object', oid: 'b'.repeat(40) }, fallback: null }));
  });

  it('renders nothing when no opener was found', async () => {
    listOpeners.mockResolvedValue([]);
    const { container } = renderButton();
    await act(async () => {});
    expect(listOpeners).toHaveBeenCalled();
    expect(container).toBeEmptyDOMElement();
  });
});

describe('OpenInMenu', () => {
  it('flips above its anchor\'s top when it doesn\'t fit below, so it never covers the button (fix round 1)', () => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ x: 0, y: 0, left: 0, top: 0, right: 100, bottom: 120, width: 100, height: 120, toJSON: () => ({}) });
    render(<OpenInMenu openers={OPENERS} at={{ x: 40, y: 700 }} above={678} onPick={() => {}} onClose={() => {}} />);
    expect(screen.getByRole('menu').style.top).toBe(`${678 - 120}px`);
    vi.restoreAllMocks();
  });

  it('shows a loading row, then the openers, keeping focus inside; or an error row (fix round 1)', () => {
    const { rerender } = render(<OpenInMenu openers={null} at={{ x: 1, y: 1 }} onPick={() => {}} onClose={() => {}} />);
    const menu = screen.getByRole('menu');
    expect(menu).toHaveTextContent('Looking for editors…');
    expect(menu).toHaveFocus();
    rerender(<OpenInMenu openers={OPENERS} current="vscode" at={{ x: 1, y: 1 }} onPick={() => {}} onClose={() => {}} />);
    expect(screen.getByRole('menuitem', { name: 'Open in VS Code' })).toHaveFocus();
    rerender(<OpenInMenu openers={null} error="no session bus" at={{ x: 1, y: 1 }} onPick={() => {}} onClose={() => {}} />);
    expect(screen.getByRole('menu')).toHaveTextContent('Couldn\'t list editors: no session bus');
  });

  it('sits at the given point and reports the pick', () => {
    const onPick = vi.fn();
    const onClose = vi.fn();
    render(<OpenInMenu openers={OPENERS} current="file-manager" at={{ x: 40, y: 50 }} onPick={onPick} onClose={onClose} />);
    const menu = screen.getByRole('menu');
    expect(menu.style.left).toBe('40px');
    expect(menu.style.top).toBe('50px');
    expect(screen.getByRole('menuitem', { name: 'Show in Files' })).toHaveFocus();
    expect(screen.getByRole('menuitem', { name: 'Other…' }).querySelector('svg')).not.toBeNull();
    fireEvent.keyDown(menu, { key: 'ArrowUp' });
    fireEvent.keyDown(screen.getByRole('menuitem', { name: 'Open in VS Code' }), { key: 'Enter' });
    expect(onPick).toHaveBeenCalledExactlyOnceWith(OPENERS[1]);
    fireEvent.keyDown(menu, { key: 'Tab' });
    expect(onClose).toHaveBeenCalled();
  });
});
