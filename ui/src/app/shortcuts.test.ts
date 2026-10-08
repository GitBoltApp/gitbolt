import { Undo2 } from 'lucide-react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { comboOf } from './shortcuts';

const ev = (init: Partial<KeyboardEvent> & { key: string; code?: string }) => ({ ctrlKey: false, shiftKey: false, altKey: false, metaKey: false, code: '', ...init }) as KeyboardEvent;

describe('comboOf', () => {
  it('names Ctrl combinations', () => {
    expect(comboOf(ev({ key: 'T', code: 'KeyT', ctrlKey: true, shiftKey: true }))).toBe('Ctrl+Shift+T');
    expect(comboOf(ev({ key: 'ƒ', code: 'KeyF', ctrlKey: true, altKey: true }))).toBe('Ctrl+Alt+F');
    expect(comboOf(ev({ key: 'Tab', code: 'Tab', ctrlKey: true }))).toBe('Ctrl+Tab');
    expect(comboOf(ev({ key: 'Tab', code: 'Tab', ctrlKey: true, shiftKey: true }))).toBe('Ctrl+Shift+Tab');
    expect(comboOf(ev({ key: 'PageDown', code: 'PageDown', ctrlKey: true }))).toBe('Ctrl+PageDown');
    expect(comboOf(ev({ key: ',', code: 'Comma', ctrlKey: true }))).toBe('Ctrl+,');
    expect(comboOf(ev({ key: '!', code: 'Digit1', ctrlKey: true, shiftKey: true }))).toBe('Ctrl+Shift+1');
  });
  it('letters follow the layout, like 1B\'s matchesLetter: by character, else by key position', () => {
    expect(comboOf(ev({ key: 'w', code: 'Comma', ctrlKey: true }))).toBe('Ctrl+W'); // Dvorak W
    expect(comboOf(ev({ key: 'z', code: 'KeyW', ctrlKey: true }))).toBe('Ctrl+Z'); // AZERTY
    expect(comboOf(ev({ key: 'ц', code: 'KeyW', ctrlKey: true }))).toBe('Ctrl+W'); // Russian
  });
  it('names function keys and Alt+digit without Ctrl too', () => {
    expect(comboOf(ev({ key: 'F8', code: 'F8' }))).toBe('F8');
    expect(comboOf(ev({ key: 'F7', code: 'F7', shiftKey: true }))).toBe('Shift+F7');
    expect(comboOf(ev({ key: 'F12', code: 'F12' }))).toBe('F12');
    expect(comboOf(ev({ key: '1', code: 'Digit1', altKey: true }))).toBe('Alt+1');
    expect(comboOf(ev({ key: '&', code: 'Digit1', altKey: true }))).toBe('Alt+1'); // AZERTY
    expect(comboOf(ev({ key: '¡', code: 'Digit1', altKey: true, shiftKey: true }))).toBe('Alt+Shift+1');
  });
  it('ignores other keys without Ctrl: letters, arrows (Alt+← is Go back, nav/input.ts), Enter', () => {
    expect(comboOf(ev({ key: 'ArrowLeft', code: 'ArrowLeft', altKey: true }))).toBe('');
    expect(comboOf(ev({ key: 'a', code: 'KeyA', altKey: true }))).toBe('');
    expect(comboOf(ev({ key: 'Enter', code: 'Enter', shiftKey: true }))).toBe('');
    expect(comboOf(ev({ key: 'F8', code: 'F8', metaKey: true }))).toBe('');
  });
  it('ignores keys without Ctrl, with Meta, lone modifiers and IME composition', () => {
    expect(comboOf(ev({ key: 'w', code: 'KeyW' }))).toBe('');
    expect(comboOf(ev({ key: 'w', code: 'KeyW', ctrlKey: true, metaKey: true }))).toBe('');
    expect(comboOf(ev({ key: 'Control', code: 'ControlLeft', ctrlKey: true }))).toBe('');
    expect(comboOf(ev({ key: 'Shift', code: 'ShiftLeft', ctrlKey: true, shiftKey: true }))).toBe('');
    expect(comboOf(ev({ key: 'w', code: 'KeyW', ctrlKey: true, isComposing: true }))).toBe('');
  });
});

describe('shortcutKeys and yieldsTo (spec #2 §5.5)', () => {
  it('leaves a combo to the focused element its action yields to', async () => {
    const { registerActions } = await import('./actions');
    const { shortcutKeys } = await import('./shortcuts');
    const run = vi.fn();
    const off = registerActions([{ id: 't.undo', label: 'Undo', group: 'Edit', icon: Undo2, tooltip: 'Undo', shortcuts: ['Ctrl+Z'], yieldsTo: (t) => t instanceof HTMLInputElement, run }]);
    const input = document.createElement('input');
    const key = (target: EventTarget) => {
      const e = new KeyboardEvent('keydown', { key: 'z', code: 'KeyZ', ctrlKey: true, bubbles: true });
      Object.defineProperty(e, 'target', { value: target });
      return shortcutKeys(e);
    };
    expect(key(input)).toBeUndefined();
    expect(run).not.toHaveBeenCalled();
    expect(key(document.body)).toBe('handled');
    expect(run).toHaveBeenCalledTimes(1);
    off();
  });
});

describe('on macOS', () => {
  const MAC_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';
  afterEach(() => vi.restoreAllMocks());
  const onMac = () => vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(MAC_UA);

  it('comboOf names Cmd chords Cmd, and keeps Ctrl chords Ctrl', () => {
    onMac();
    expect(comboOf(ev({ key: 'n', code: 'KeyN', metaKey: true, shiftKey: true }))).toBe('Cmd+Shift+N');
    expect(comboOf(ev({ key: 'ß', code: 'KeyS', metaKey: true, altKey: true }))).toBe('Cmd+Alt+S'); // Option changes the character
    expect(comboOf(ev({ key: ',', code: 'Comma', metaKey: true }))).toBe('Cmd+,');
    expect(comboOf(ev({ key: '1', code: 'Digit1', metaKey: true }))).toBe('Cmd+1');
    expect(comboOf(ev({ key: 'Tab', code: 'Tab', ctrlKey: true }))).toBe('Ctrl+Tab');
    expect(comboOf(ev({ key: 'F8', code: 'F8' }))).toBe('F8');
    expect(comboOf(ev({ key: 'w', code: 'KeyW', ctrlKey: true, metaKey: true }))).toBe('');
    expect(comboOf(ev({ key: 'Meta', code: 'MetaLeft', metaKey: true }))).toBe('');
  });

  it('a Mod shortcut is Cmd: Cmd+B runs it, Ctrl+B does not', async () => {
    onMac();
    const { registerActions } = await import('./actions');
    const { shortcutKeys } = await import('./shortcuts');
    const run = vi.fn();
    const off = registerActions([{ id: 't.mod', label: 'Mod', group: 'View', icon: Undo2, tooltip: 'Mod', shortcuts: ['Mod+B'], run }]);
    const press = (init: KeyboardEventInit) => shortcutKeys(new KeyboardEvent('keydown', { key: 'b', code: 'KeyB', ...init }));
    expect(press({ ctrlKey: true })).toBeUndefined();
    expect(run).not.toHaveBeenCalled();
    expect(press({ metaKey: true })).toBe('handled');
    expect(run).toHaveBeenCalledTimes(1);
    off();
  });
});

describe('a Mod shortcut on Linux', () => {
  it('is Ctrl, stored as Ctrl', async () => {
    const { registerActions, getAction } = await import('./actions');
    const { shortcutKeys } = await import('./shortcuts');
    const run = vi.fn();
    const off = registerActions([{ id: 't.modLinux', label: 'Mod', group: 'View', icon: Undo2, tooltip: 'Mod', shortcuts: ['Mod+Shift+B'], run }]);
    expect(getAction('t.modLinux')?.shortcuts).toEqual(['Ctrl+Shift+B']);
    expect(shortcutKeys(new KeyboardEvent('keydown', { key: 'B', code: 'KeyB', metaKey: true, shiftKey: true }))).toBeUndefined();
    expect(shortcutKeys(new KeyboardEvent('keydown', { key: 'B', code: 'KeyB', ctrlKey: true, shiftKey: true }))).toBe('handled');
    expect(run).toHaveBeenCalledTimes(1);
    off();
  });
});
