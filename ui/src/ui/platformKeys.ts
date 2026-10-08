import { osKind } from '../app/osPath';

/** Whether the app runs on macOS, where the primary shortcut modifier is Cmd (⌘), not Ctrl. */
export const isMac = (): boolean => osKind() === 'macos';

/**
 * Chords are declared with `Mod` for the platform's primary modifier: Cmd on macOS, Ctrl on Linux
 * and Windows (`Mod+Shift+N` is ⇧⌘N on a Mac, Ctrl+Shift+N elsewhere). The action and hint
 * registries resolve it when they register, into the name `comboOf` gives the key press, so the
 * rest of the app compares and stores `Ctrl+…` or `Cmd+…`. A chord written with `Ctrl` stays Ctrl
 * on a Mac too: Ctrl+Tab, where the Mac convention keeps it.
 */
export function resolveChord(chord: string): string {
  return chord.startsWith('Mod+') ? `${isMac() ? 'Cmd' : 'Ctrl'}${chord.slice(3)}` : chord;
}

/** Whether the platform's primary modifier, and only it of Ctrl and Cmd, is held: Ctrl (not
 * Super) on Linux and Windows, Cmd (not Ctrl) on macOS. For the keys read off the event rather
 * than through `comboOf` (zoom). */
export function hasPrimaryMod(e: Pick<KeyboardEvent, 'ctrlKey' | 'metaKey'>): boolean {
  return isMac() ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
}

/** 'Ctrl+Shift+T' into its keycaps (a trailing '+' key stays a key). */
export const keycaps = (chord: string): string[] => chord.split(/\+(?=.)/);

const MAC_MODIFIERS: Record<string, string> = { Ctrl: '⌃', Alt: '⌥', Shift: '⇧', Cmd: '⌘' };
const MAC_ORDER = ['Ctrl', 'Alt', 'Shift', 'Cmd'];
const MAC_KEYS: Record<string, string> = { Up: '↑', Down: '↓', Left: '←', Right: '→' };

/** A chord's keycaps, for the Keyboard Shortcuts panel: `['Ctrl', 'Shift', 'N']`, or on macOS the
 * glyphs in Apple's order (⌃⌥⇧⌘), `['⇧', '⌘', 'N']`. */
export function chordKeycaps(chord: string): string[] {
  const keys = keycaps(resolveChord(chord));
  if (!isMac()) return keys;
  const key = keys[keys.length - 1];
  const mods = keys.slice(0, -1);
  if (!mods.every((m) => m in MAC_MODIFIERS)) return keys;
  return [...MAC_ORDER.filter((m) => mods.includes(m)).map((m) => MAC_MODIFIERS[m]), MAC_KEYS[key] ?? key];
}

/** A chord as menus, tooltips and the palette show it: 'Ctrl+Shift+N', or '⇧⌘N' on macOS. */
export const displayChord = (chord: string): string => chordKeycaps(chord).join(isMac() ? '' : '+');
