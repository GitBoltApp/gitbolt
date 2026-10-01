import { act, fireEvent } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DiffTarget } from '../repo/store';

vi.mock('../api/client', () => ({ api: { saveProfile: vi.fn(async () => null), saveSettings: vi.fn(async () => null) } }));
vi.mock('../api/transport', () => ({ copyText: vi.fn(async () => {}), inTauri: () => false }));

await import('./coreActions');
const { installShortcuts } = await import('./shortcuts');
const { activeTabWith } = await import('./testShell');
const { useAppState } = await import('./state');
const { registerKeys } = await import('../ui/keyRouter');

const target: DiffTarget = { key: 'k|a.txt', path: 'a.txt', oldPath: null, status: 'M', old: { kind: 'absent' }, new: { kind: 'absent' }, view: 'diff' };
const tabs = () => useAppState.getState().profile.tabs.map((t) => t.id);
const active = () => useAppState.getState().profile.activeTab;
/** fireEvent's result: false when the key's default was prevented (it was taken). */
const press = (init: KeyboardEventInit, on: Element = document.body) => fireEvent.keyDown(on, init);

describe('the app\'s shortcuts through the key router (ruling R6)', () => {
  let off: () => void;
  beforeEach(() => { off = installShortcuts(); });
  afterEach(() => off());

  it('Ctrl+W closes the open file if there is one, else the tab: never both on one press', () => {
    const store = activeTabWith();
    act(() => store.getState().openFile(target));
    expect(press({ key: 'w', code: 'KeyW', ctrlKey: true })).toBe(false);
    expect(store.getState().diff).toBeNull();
    expect(store.getState().focus).toBe('graph');
    expect(tabs()).toEqual(['t', 'u']);
    expect(press({ key: 'w', code: 'KeyW', ctrlKey: true })).toBe(false);
    expect(tabs()).toEqual(['u']);
    expect(active()).toBe('u');
    expect(useAppState.getState().profile.closedTabs).toEqual([{ path: '/t', alias: null, index: 0 }]);
  });

  it('Ctrl+W on any layout (Dvorak W on Comma), and not with Shift, Alt or Meta', () => {
    const store = activeTabWith();
    act(() => store.getState().openFile(target));
    for (const mods of [{ shiftKey: true }, { altKey: true }, { metaKey: true }]) expect(press({ key: 'w', code: 'KeyW', ctrlKey: true, ...mods })).toBe(true);
    expect(store.getState().diff).not.toBeNull();
    expect(press({ key: 'w', code: 'Comma', ctrlKey: true })).toBe(false);
    expect(store.getState().diff).toBeNull();
  });

  it('works while typing in a text box (spec §11.1: Ctrl chords do)', () => {
    const store = activeTabWith();
    act(() => store.getState().openFile(target));
    const input = document.body.appendChild(document.createElement('input'));
    expect(press({ key: 'w', code: 'KeyW', ctrlKey: true }, input)).toBe(false);
    expect(store.getState().diff).toBeNull();
    input.remove();
  });

  it('an open menu takes the key first: nothing behind it acts', () => {
    activeTabWith();
    const offMenu = registerKeys('menu', () => 'handled');
    try {
      press({ key: 'w', code: 'KeyW', ctrlKey: true });
      expect(tabs()).toEqual(['t', 'u']);
      press({ key: 'Tab', code: 'Tab', ctrlKey: true });
      expect(active()).toBe('t');
    } finally {
      offMenu();
    }
  });

  it('Ctrl+Tab / Ctrl+Shift+Tab / Ctrl+PageDown / Ctrl+PageUp switch tabs; Ctrl+Shift+T reopens', () => {
    activeTabWith(undefined, ['t', 'u', 'v']);
    press({ key: 'Tab', code: 'Tab', ctrlKey: true });
    expect(active()).toBe('u');
    press({ key: 'PageDown', code: 'PageDown', ctrlKey: true });
    expect(active()).toBe('v');
    press({ key: 'Tab', code: 'Tab', ctrlKey: true, shiftKey: true });
    expect(active()).toBe('u');
    press({ key: 'PageUp', code: 'PageUp', ctrlKey: true });
    expect(active()).toBe('t');
    press({ key: 'w', code: 'KeyW', ctrlKey: true });
    expect(tabs()).toEqual(['u', 'v']);
    expect(press({ key: 'T', code: 'KeyT', ctrlKey: true, shiftKey: true })).toBe(false);
    // Back at its old place (a new tab id), and active.
    const p = useAppState.getState().profile;
    expect(p.tabs.map((t) => t.path)).toEqual(['/t', '/u', '/v']);
    expect(p.activeTab).toBe(p.tabs[0].id);
    // Nothing left to reopen: the chord passes through.
    expect(press({ key: 'T', code: 'KeyT', ctrlKey: true, shiftKey: true })).toBe(true);
  });

  it('Ctrl+P and Ctrl+O never reach the browser (print, open file), even behind a menu', () => {
    activeTabWith();
    expect(press({ key: 'p', code: 'KeyP', ctrlKey: true })).toBe(false);
    expect(press({ key: 'o', code: 'KeyO', ctrlKey: true })).toBe(false);
    const offMenu = registerKeys('menu', () => 'handled');
    expect(press({ key: 'p', code: 'KeyP', ctrlKey: true })).toBe(false);
    offMenu();
    // Ctrl+W with no tab open (nothing to close): never the browser's close-tab either.
    useAppState.setState({ profile: { ...useAppState.getState().profile, tabs: [], activeTab: null } });
    expect(press({ key: 'w', code: 'KeyW', ctrlKey: true })).toBe(false);
    // Other unbound chords are left alone.
    expect(press({ key: 'k', code: 'KeyK', ctrlKey: true })).toBe(true);
  });
});
