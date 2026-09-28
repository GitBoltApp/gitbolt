import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Copy } from 'lucide-react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GraphPayload } from '../api/gen/GraphPayload';
import { useChangeKeys } from '../diff/changeKeys';
import { goToChange } from '../diff/DiffToolbar';
import { ContextMenu } from '../menu/ContextMenu';
import { useMenu } from '../menu/menuStore';
import type { MenuRow } from '../menu/types';
import { HoverTooltip } from '../ui/HoverTooltip';
import { useAppEscape, useEscapeOwner } from './escape';
import { createRepoViewStore, type DiffTarget, type RepoViewStore } from './store';
import { fakeServices } from './testServices';

// The change keys' action; the routing is what's under test.
vi.mock('../diff/DiffToolbar', () => ({ goToChange: vi.fn() }));

/**
 * The key router's precedence with the real parts (ui/keyRouter.ts): an open menu, then a shown
 * tooltip, then an editor overlay, then the app's keys (Esc closes the file, F7 / Shift+↑↓ step
 * the changes). Each rule is checked with the lower layers all armed, and with the menu opened
 * after the app's keys registered (M's own listener used to lose to them that way).
 */
const graph: GraphPayload = { rows: [], labels: [], maxLanes: 0, pinnedRef: null, head: { branch: null, target: null, detached: false, unborn: true }, truncated: false };
const target: DiffTarget = { key: 'k|a.txt', path: 'a.txt', oldPath: null, status: 'M', old: { kind: 'absent' }, new: { kind: 'absent' }, view: 'diff' };
const action = (id: string, run = vi.fn()): MenuRow => ({ kind: 'action', id, label: id, icon: Copy, tooltip: id, run });

/** An editor overlay (Monaco's find widget), open or not, that owns Esc pressed in the editor. */
const overlay = { open: false };
const owns = vi.fn((e: KeyboardEvent) => overlay.open && e.composedPath().some((n) => n instanceof Element && n.matches('.monaco-editor')));

function AppKeys({ store }: { store: RepoViewStore }) {
  useAppEscape(store);
  useChangeKeys(true);
  useEscapeOwner(owns);
  return null;
}

let store: RepoViewStore;
const editorKeys = vi.fn();
function Page({ keys }: { keys: boolean }) {
  return (
    <>
      <div data-focus-zone="files"><button type="button">row</button></div>
      <div className="monaco-editor"><textarea aria-label="editor" onKeyDown={(e) => editorKeys(e.key)} /></div>
      <HoverTooltip content="tip"><span>trigger</span></HoverTooltip>
      <ContextMenu />
      {keys && <AppKeys store={store} />}
    </>
  );
}
function mount({ keys = true } = {}) {
  store = createRepoViewStore(1, '/r', graph, fakeServices());
  act(() => store.getState().openFile(target));
  return render(<Page keys={keys} />);
}
const editor = () => screen.getByLabelText('editor');
const openMenu = () => act(() => useMenu.getState().show([action('a'), action('b')], 0, 0));
const menuOpen = () => screen.getByRole('menu', { hidden: true }).hidden === false;
const showTip = () => fireEvent.mouseEnter(screen.getByText('trigger'));

beforeEach(() => {
  overlay.open = false;
  vi.mocked(goToChange).mockClear();
  owns.mockClear();
  editorKeys.mockClear();
});
afterEach(() => {
  act(() => useMenu.getState().close());
  cleanup();
});

describe('key precedence: menu > tooltip > editor overlay > app', () => {
  for (const appFirst of [true, false]) {
    it(`an open menu takes F7, Shift+↑↓ and Esc over everything below it (app keys registered ${appFirst ? 'before' : 'after'} the menu opened)`, () => {
      const view = mount({ keys: appFirst });
      overlay.open = true;
      editor().focus();
      showTip();
      openMenu();
      if (!appFirst) view.rerender(<Page keys />);
      // Focus left in the editor (a stray focus call): the menu still gets the keys.
      editor().focus();
      fireEvent.keyDown(editor(), { key: 'F7' });
      fireEvent.keyDown(editor(), { key: 'ArrowDown', shiftKey: true });
      fireEvent.keyDown(editor(), { key: 'ArrowUp', shiftKey: true });
      expect(goToChange).not.toHaveBeenCalled();
      expect(editorKeys).not.toHaveBeenCalled();
      expect(screen.getByRole('menu').querySelector('[data-active="true"]')).toHaveAttribute('data-row-id', 'a');
      fireEvent.keyDown(editor(), { key: 'Escape' });
      expect(menuOpen()).toBe(false);
      expect(owns).not.toHaveBeenCalled();
      expect(store.getState().diff).not.toBeNull();
      expect(editorKeys).not.toHaveBeenCalled();
    });
  }

  it('a shown menu of its own (the Open in… dropdown) keeps F7, Shift+↓ and Esc for its handler', () => {
    mount();
    const own = vi.fn();
    const menu = document.createElement('div');
    menu.setAttribute('role', 'menu');
    menu.innerHTML = '<button role="menuitem">PhpStorm</button>';
    menu.addEventListener('keydown', (e) => own(e.key));
    document.body.append(menu);
    const item = menu.querySelector('button')!;
    item.focus();
    fireEvent.keyDown(item, { key: 'F7' });
    fireEvent.keyDown(item, { key: 'ArrowDown', shiftKey: true });
    fireEvent.keyDown(item, { key: 'Escape' });
    expect(own).toHaveBeenCalledWith('F7');
    expect(own).toHaveBeenCalledWith('Escape');
    expect(goToChange).not.toHaveBeenCalled();
    expect(store.getState().diff).not.toBeNull();
    menu.remove();
  });

  it('a shown tooltip takes Esc before an editor overlay and the app; the next Esc goes on down', () => {
    mount();
    overlay.open = true;
    editor().focus();
    showTip();
    expect(fireEvent.keyDown(editor(), { key: 'Escape' })).toBe(false);
    expect(screen.queryByRole('tooltip')).toBeNull();
    expect(owns).not.toHaveBeenCalled();
    expect(editorKeys).not.toHaveBeenCalled();
    expect(store.getState().diff).not.toBeNull();
    // Only Esc: F7 with a tooltip shown still steps (the tooltip layer claims nothing else).
    showTip();
    fireEvent.keyDown(editor(), { key: 'F7' });
    expect(goToChange).toHaveBeenCalledWith('next');
  });

  it("an editor overlay takes Esc pressed in the editor before the app: it reaches Monaco, the file stays", () => {
    mount();
    overlay.open = true;
    editor().focus();
    expect(fireEvent.keyDown(editor(), { key: 'Escape' })).toBe(true);
    expect(owns).toHaveBeenCalled();
    expect(editorKeys).toHaveBeenCalledWith('Escape');
    expect(store.getState().diff).not.toBeNull();
    // From outside the editor the overlay claims nothing: the app closes the file.
    const row = screen.getByRole('button', { name: 'row' });
    row.focus();
    expect(fireEvent.keyDown(row, { key: 'Escape' })).toBe(false);
    expect(store.getState().diff).toBeNull();
  });

  it('with nothing above them, the app keys act: F7 / Shift+↓ step, Esc closes the file', () => {
    mount();
    const row = screen.getByRole('button', { name: 'row' });
    row.focus();
    fireEvent.keyDown(row, { key: 'F7' });
    fireEvent.keyDown(row, { key: 'ArrowDown', shiftKey: true });
    expect(vi.mocked(goToChange).mock.calls).toEqual([['next'], ['next']]);
    fireEvent.keyDown(row, { key: 'Escape' });
    expect(store.getState().diff).toBeNull();
  });
});
