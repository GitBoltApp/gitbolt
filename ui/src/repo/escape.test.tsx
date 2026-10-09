import { act, fireEvent, render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { GraphPayload } from '../api/gen/GraphPayload';
import { isEditorKey } from '../ui/keys';
import { useAppEscape, useEscapeOwner } from './escape';
import { createRepoViewStore, type DiffTarget, type RepoViewStore } from './store';
import { fakeServices } from './testServices';
import '../app/coreActions';
import { installShortcuts } from '../app/shortcuts';
import { activeTabWith } from '../app/testShell';

const graph: GraphPayload = { rows: [], labels: [], maxLanes: 0, pinnedRefs: [], head: { branch: null, target: null, detached: false, unborn: true }, truncated: false, worktrees: [] };
const target: DiffTarget = { key: 'k|a.txt', path: 'a.txt', oldPath: null, status: 'M', old: { kind: 'absent' }, new: { kind: 'absent' }, view: 'diff' };

function mount(owns: (e: KeyboardEvent) => boolean) {
  const store: RepoViewStore = createRepoViewStore(1, '/r', graph, fakeServices());
  const Host = () => {
    useAppEscape(store);
    useEscapeOwner(owns);
    return <div data-focus-zone="files"><button type="button">in the files</button></div>;
  };
  const view = render(<Host />);
  return { store, button: view.getByRole('button'), view };
}

describe('useAppEscape (J4)', () => {
  it('leaves Esc to editable text of the app (isContentEditable, any spelling), not Monaco', () => {
    const { store, view } = mount(() => false);
    act(() => store.getState().openFile(target));
    const box = document.createElement('div');
    box.setAttribute('contenteditable', 'plaintext-only');
    // jsdom has no isContentEditable: the browser's answer.
    Object.defineProperty(box, 'isContentEditable', { configurable: true, value: true });
    document.body.append(box);
    expect(fireEvent.keyDown(box, { key: 'Escape' })).toBe(true);
    expect(store.getState().diff).not.toBeNull();
    // Not editable: Esc closes the file.
    Object.defineProperty(box, 'isContentEditable', { configurable: true, value: false });
    expect(fireEvent.keyDown(box, { key: 'Escape' })).toBe(false);
    expect(store.getState().diff).toBeNull();
    box.remove();
    view.unmount();
  });

  it('leaves Esc to an area that owns it (data-owns-escape: review cards, a comment box\'s Preview)', () => {
    const { store, view } = mount(() => false);
    act(() => store.getState().openFile(target));
    const area = document.createElement('div');
    area.setAttribute('data-owns-escape', '');
    const pane = area.appendChild(document.createElement('div'));
    pane.tabIndex = 0;
    document.body.append(area);
    expect(fireEvent.keyDown(pane, { key: 'Escape' })).toBe(true);
    expect(store.getState().diff).not.toBeNull();
    area.remove();
    view.unmount();
  });

  it('asks the owners only while the store has a file open, never inferring it from the DOM', () => {
    const owns = vi.fn(() => true);
    const { store, button, view } = mount(owns);
    // No file open (a kept, hidden diff panel may still be in the DOM): the owners aren't asked,
    // and Esc in the file list goes back to the graph.
    act(() => store.getState().setFocus('files'));
    let seen: KeyboardEvent | null = null;
    const spy = (e: KeyboardEvent) => { seen = e; };
    window.addEventListener('keydown', spy, true);
    expect(fireEvent.keyDown(button, { key: 'Escape' })).toBe(false);
    expect(owns).not.toHaveBeenCalled();
    expect(store.getState().focus).toBe('graph');
    // A file open: the owner claims it, the key is marked for the editor, the file stays.
    act(() => store.getState().openFile(target));
    expect(fireEvent.keyDown(button, { key: 'Escape' })).toBe(true);
    expect(owns).toHaveBeenCalledTimes(1);
    expect(seen && isEditorKey(seen)).toBe(true);
    expect(store.getState().diff).not.toBeNull();
    // No longer claimed: Esc closes it.
    owns.mockReturnValue(false);
    expect(fireEvent.keyDown(button, { key: 'Escape' })).toBe(false);
    expect(store.getState().diff).toBeNull();
    window.removeEventListener('keydown', spy, true);
    view.unmount();
  });
});

describe('Ctrl+W (I1), the app\'s shortcut since plan 1C', () => {
  it('is no longer the view\'s: useAppEscape leaves it alone', () => {
    const { store, view } = mount(() => false);
    act(() => store.getState().openFile(target));
    expect(fireEvent.keyDown(document.body, { key: 'w', ctrlKey: true })).toBe(true);
    expect(store.getState().diff).not.toBeNull();
    view.unmount();
  });

  it('closes the open file even when the keydown target is <body> (focus fell off after a click on non-focusable content)', () => {
    const { store, view } = mount(() => true);
    const off = installShortcuts();
    activeTabWith(store);
    act(() => store.getState().openFile(target));
    // An Esc owner (an editor overlay) claims only a plain Esc, never Ctrl+W.
    expect(fireEvent.keyDown(document.body, { key: 'w', ctrlKey: true })).toBe(false);
    expect(store.getState().diff).toBeNull();
    expect(store.getState().focus).toBe('graph');
    off();
    view.unmount();
  });
});
