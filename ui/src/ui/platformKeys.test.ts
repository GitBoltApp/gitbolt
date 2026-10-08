import { afterEach, describe, expect, it, vi } from 'vitest';
import { chordKeycaps, displayChord, hasPrimaryMod, isMac, resolveChord } from './platformKeys';

const MAC_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';
const onMac = () => vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(MAC_UA);
afterEach(() => vi.restoreAllMocks());

const key = (init: Partial<KeyboardEvent>) => ({ ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...init });

describe('the primary modifier (Mod)', () => {
  it('is Ctrl on Linux and Windows: chords and their display are unchanged', () => {
    expect(isMac()).toBe(false);
    expect(resolveChord('Mod+Shift+N')).toBe('Ctrl+Shift+N');
    expect(resolveChord('Mod+,')).toBe('Ctrl+,');
    expect(resolveChord('Ctrl+Tab')).toBe('Ctrl+Tab');
    expect(resolveChord('Alt+1')).toBe('Alt+1');
    expect(displayChord('Mod+Alt+S')).toBe('Ctrl+Alt+S');
    expect(displayChord('Ctrl+Shift+T')).toBe('Ctrl+Shift+T');
    expect(displayChord('Shift+F7')).toBe('Shift+F7');
    expect(chordKeycaps('Mod+Shift+N')).toEqual(['Ctrl', 'Shift', 'N']);
    expect(chordKeycaps('Mod+=')).toEqual(['Ctrl', '=']);
    expect(chordKeycaps('Mod++')).toEqual(['Ctrl', '+']);
  });

  it('is Cmd on macOS, shown with the Mac glyphs in the Mac order (⌃⌥⇧⌘)', () => {
    onMac();
    expect(isMac()).toBe(true);
    expect(resolveChord('Mod+Shift+N')).toBe('Cmd+Shift+N');
    expect(resolveChord('Mod+,')).toBe('Cmd+,');
    expect(resolveChord('Ctrl+Tab')).toBe('Ctrl+Tab');
    expect(displayChord('Mod+Shift+N')).toBe('⇧⌘N');
    expect(displayChord('Cmd+Shift+N')).toBe('⇧⌘N');
    expect(displayChord('Mod+Alt+S')).toBe('⌥⌘S');
    expect(displayChord('Mod+,')).toBe('⌘,');
    expect(displayChord('Ctrl+Tab')).toBe('⌃Tab');
    expect(displayChord('Ctrl+Shift+Tab')).toBe('⌃⇧Tab');
    expect(displayChord('Shift+F7')).toBe('⇧F7');
    expect(displayChord('Alt+Left')).toBe('⌥←');
    expect(displayChord('Mod+Up')).toBe('⌘↑');
    expect(displayChord('Mod+=')).toBe('⌘=');
    expect(displayChord('Mouse back')).toBe('Mouse back');
    expect(displayChord('Esc')).toBe('Esc');
    expect(chordKeycaps('Mod+Shift+N')).toEqual(['⇧', '⌘', 'N']);
    expect(chordKeycaps('Ctrl+Alt+Shift+Cmd+K')).toEqual(['⌃', '⌥', '⇧', '⌘', 'K']);
    expect(chordKeycaps('Down')).toEqual(['↓']);
  });

  it('hasPrimaryMod: Ctrl (not Super) on Linux, Cmd (not Ctrl) on macOS', () => {
    expect(hasPrimaryMod(key({ ctrlKey: true }))).toBe(true);
    expect(hasPrimaryMod(key({ metaKey: true }))).toBe(false);
    expect(hasPrimaryMod(key({ ctrlKey: true, metaKey: true }))).toBe(false);
    onMac();
    expect(hasPrimaryMod(key({ metaKey: true }))).toBe(true);
    expect(hasPrimaryMod(key({ ctrlKey: true }))).toBe(false);
    expect(hasPrimaryMod(key({ ctrlKey: true, metaKey: true }))).toBe(false);
  });
});
