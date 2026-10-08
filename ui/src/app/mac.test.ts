import { render, screen } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createElement } from 'react';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { Action } from './actions';

/**
 * The whole registry as macOS sees it: the user agent says Mac before any feature registers, so
 * every `Mod` chord resolves to Cmd (`ui/platformKeys.ts`). Linux's own checks are
 * `registry.test.ts`, unchanged.
 */
const MAC_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';
vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(MAC_UA);

let all: Action[] = [];
let hints: Array<{ id: string; keys: string[] }> = [];
let actions: typeof import('./actions');
let shortcuts: typeof import('./shortcuts');
beforeAll(async () => {
  await import('./features');
  await import('../shortcuts/viewHints');
  actions = await import('./actions');
  shortcuts = await import('./shortcuts');
  all = actions.allActions();
  hints = (await import('../shortcuts/hints')).keyHints();
}, 60000);

const bound = () => all.flatMap((a) => (a.keysBy ? [] : (a.shortcuts ?? []).map((k) => ({ k, a }))));
const keydown = (init: KeyboardEventInit) => new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });

/** macOS's own keys, which reach the system or AppKit's menus whatever the app binds, and the
 * text-editing keys (Cmd+A/C/V/X, and the Emacs-style Ctrl+letters in every text field). */
const MAC_RESERVED = [
  'Cmd+H', 'Cmd+Alt+H', 'Cmd+M', 'Cmd+Alt+M', 'Cmd+Q', 'Cmd+`', 'Cmd+Tab', 'Cmd+Space', 'Cmd+Alt+Space', 'Cmd+Alt+D', 'Cmd+Shift+/',
  'Cmd+Shift+3', 'Cmd+Shift+4', 'Cmd+Shift+5', 'Cmd+Shift+6', // screenshots
  'Ctrl+Up', 'Ctrl+Down', 'Ctrl+Left', 'Ctrl+Right', 'Ctrl+Space', // Mission Control, input sources
  'Cmd+A', 'Cmd+C', 'Cmd+V', 'Cmd+X',
];
/** The Ctrl chords macOS keeps: tab cycling, as in Safari, and ⌃1–4 for the focus zones (Option+digit types a character). */
const MAC_CTRL = new Set(['Ctrl+Tab', 'Ctrl+Shift+Tab', 'Ctrl+PageDown', 'Ctrl+PageUp', 'Ctrl+1', 'Ctrl+2', 'Ctrl+3', 'Ctrl+4']);

describe('the shortcuts on macOS', () => {
  it('every declared Mod chord resolved to Cmd, in actions and key hints alike', () => {
    for (const { k, a } of bound()) expect(k, a.id).not.toMatch(/^Mod\+/);
    for (const h of hints) for (const k of h.keys) expect(k, h.id).not.toMatch(/^Mod\+/);
    expect(hints.find((h) => h.id === 'key.zoomIn')?.keys).toEqual(['Cmd+=']);
    expect(hints.find((h) => h.id === 'key.commit')?.keys).toEqual(['Cmd+Enter']);
  });

  it("binds none of macOS's own keys, nor its text-editing keys", () => {
    for (const { k, a } of bound()) {
      expect(MAC_RESERVED, `${a.id} (${k})`).not.toContain(k);
      if (k.startsWith('Ctrl+')) expect(MAC_CTRL.has(k), `${a.id} (${k}): Ctrl stays Ctrl only where macOS keeps it`).toBe(true);
    }
  });

  it('the remaps', () => {
    const keys = (id: string) => actions.getAction(id)?.shortcuts;
    expect(keys('file.settings')).toEqual(['Cmd+,']);
    expect(keys('edit.palette')).toEqual(['Cmd+P']);
    expect(keys('file.closeTab')).toEqual(['Cmd+W']);
    expect(keys('sync.push')).toEqual(['Cmd+Shift+K']);
    expect(keys('stash.push')).toEqual(['Cmd+Alt+S']);
    expect(keys('view.tab1')).toEqual(['Cmd+1']);
    expect(keys('view.nextTab')).toEqual(['Ctrl+Tab', 'Ctrl+PageDown', 'Cmd+Shift+]']);
    expect(keys('view.prevTab')).toEqual(['Ctrl+Shift+Tab', 'Ctrl+PageUp', 'Cmd+Shift+[']);
    // ⇧⌘3 / ⇧⌘4 are the system's screenshot keys.
    expect(['hunk', 'inline', 'split'].map((m) => keys(`diff.mode.${m}`))).toEqual([['Cmd+Alt+1'], ['Cmd+Alt+2'], ['Cmd+Alt+3']]);
    expect(['Sidebar', 'Graph', 'Files', 'Diff'].map((z) => keys(`view.focus${z}`))).toEqual([['Ctrl+1'], ['Ctrl+2'], ['Ctrl+3'], ['Ctrl+4']]);
    expect(keys('nav.back')?.[0]).toBe('Cmd+[');
    expect(keys('nav.forward')?.[0]).toBe('Cmd+]');
  });

  it('Cmd runs an app shortcut; Ctrl with the same key does not', () => {
    // Whichever action holds the combo, usable now or not (Pop needs a stash, the focus keys a repo tab).
    const at = (init: KeyboardEventInit) => {
      const combo = shortcuts.comboOf(keydown(init));
      return combo ? bound().find(({ k }) => k === combo)?.a.id : undefined;
    };
    expect(at({ key: ',', code: 'Comma', metaKey: true })).toBe('file.settings');
    expect(at({ key: ',', code: 'Comma', ctrlKey: true })).toBeUndefined();
    expect(at({ key: 'π', code: 'KeyP', metaKey: true, altKey: true })).toBe('stash.pop');
    expect(at({ key: '1', code: 'Digit1', ctrlKey: true })).toBe('view.focusSidebar');
  });

  it('Cmd+A / C / V / X / Z / Shift+Z in a text field stay native editing: nothing prevents them', async () => {
    const { installZoom } = await import('../ui/zoom');
    const { installFontZoom } = await import('../diff/fontZoom');
    const offs = [shortcuts.installShortcuts(), installZoom(() => {}), installFontZoom()];
    const input = document.createElement('input');
    document.body.append(input);
    input.focus();
    for (const [key, shiftKey] of [['a', false], ['c', false], ['v', false], ['x', false], ['z', false], ['z', true]] as const) {
      const e = keydown({ key, code: `Key${key.toUpperCase()}`, metaKey: true, shiftKey });
      input.dispatchEvent(e);
      expect(e.defaultPrevented, `Cmd+${shiftKey ? 'Shift+' : ''}${key}`).toBe(false);
    }
    // The app's own Undo / Redo is Cmd+Z there too, and leaves a text field's to the field.
    expect(actions.getAction('edit.undo')?.shortcuts).toEqual(['Cmd+Z']);
    expect(actions.getAction('edit.undo')?.yieldsTo?.(input)).toBe(true);
    expect(actions.getAction('edit.redo')?.yieldsTo?.(input)).toBe(true);
    input.remove();
    for (const off of offs) off();
  });

  it('Cmd+= zooms, Ctrl+= does not', async () => {
    const { installZoom, useZoom, setZoom } = await import('../ui/zoom');
    const off = installZoom(() => {});
    setZoom(100);
    document.body.dispatchEvent(keydown({ key: '=', code: 'Equal', ctrlKey: true }));
    expect(useZoom.getState().zoom).toBe(100);
    document.body.dispatchEvent(keydown({ key: '=', code: 'Equal', metaKey: true }));
    expect(useZoom.getState().zoom).toBe(110);
    setZoom(100);
    off();
  });

  it('⌘[ and ⌘] are Go back / forward, except in a text field', async () => {
    const { navKeys } = await import('../nav/input');
    expect(navKeys(keydown({ key: '[', code: 'BracketLeft', metaKey: true }))).toBe('handled');
    expect(navKeys(keydown({ key: ']', code: 'BracketRight', metaKey: true }))).toBe('handled');
    expect(navKeys(keydown({ key: '[', code: 'BracketLeft', ctrlKey: true }))).toBeUndefined();
    const input = document.createElement('input');
    document.body.append(input);
    const e = keydown({ key: '[', code: 'BracketLeft', metaKey: true });
    Object.defineProperty(e, 'target', { value: input });
    expect(navKeys(e)).toBeUndefined();
    input.remove();
  });

  it("the menu bar's items (crates/gitbolt-app/src/menu.rs) name registered actions, with their own shortcuts", () => {
    const rust = readFileSync(join(__dirname, '../../../crates/gitbolt-app/src/menu.rs'), 'utf8');
    const items = [...rust.matchAll(/action\("([^"]+)", "[^"]+", (?:Some\("([^"]+)"\)|None)\)/g)].map((m) => ({ id: m[1], accel: m[2] }));
    expect(items.map((i) => i.id)).toEqual(expect.arrayContaining(['help.about', 'file.settings', 'help.checkUpdates', 'file.quit', 'help.shortcuts']));
    for (const { id, accel } of items) {
      const a = actions.getAction(id);
      expect(a, id).toBeDefined();
      // Quit has no shortcut of its own: ⌘Q is the menu's.
      if (accel && id !== 'file.quit') expect(a?.shortcuts?.[0], id).toBe(accel);
    }
  });

  it('the Keyboard Shortcuts panel shows the Mac glyphs', async () => {
    const { ShortcutsPanel, useShortcutsUi } = await import('../shortcuts/ShortcutsPanel');
    useShortcutsUi.getState().setOpen(true);
    render(createElement(ShortcutsPanel));
    const row = screen.getAllByText('Command palette').map((el) => el.closest('li')).find(Boolean)!;
    expect([...row.querySelectorAll('kbd')].map((k) => k.textContent)).toEqual(['⌘', 'P']);
    const dialog = screen.getByRole('dialog', { name: 'Keyboard Shortcuts' });
    expect(dialog.querySelector('h2 .sc-chord')?.textContent).toBe('⌘/');
    expect(screen.getByLabelText('Filter shortcuts').getAttribute('placeholder')).toBe('Filter shortcuts (⌘F)');
    useShortcutsUi.getState().setOpen(false);
  });
});
