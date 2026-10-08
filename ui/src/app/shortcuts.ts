import { useEffect } from 'react';
import { registerKeys, type KeyHandler } from '../ui/keyRouter';
import { letterOf } from '../ui/keys';
import { isMac, resolveChord } from '../ui/platformKeys';
import { actionForCombo, invoke } from './actions';
import { installNativeMenu } from './nativeMenu';

const CODE_NAMES: Record<string, string> = { Comma: ',', Equal: '=', Minus: '-', Period: '.', Slash: '/', Backquote: '`', BracketLeft: '[', BracketRight: ']', Semicolon: ';', Quote: "'", Backslash: '\\' };
const MODIFIERS = new Set(['Control', 'Shift', 'Alt', 'Meta', 'AltGraph', 'OS']);

const FUNCTION_KEY = /^F([1-9]|1[0-2])$/;

/**
 * "Ctrl+Shift+T" for a Ctrl chord, "F8" / "Shift+F7" for a function key, "Alt+1" for Alt and a
 * digit (the focus keys); '' for anything else (another key without Ctrl, a Super/Meta chord, a
 * lone modifier, IME composition). On macOS a Cmd chord is "Cmd+Shift+T" (the primary modifier
 * there, `Mod` in declarations: `ui/platformKeys.ts`), a Ctrl one stays "Ctrl+Tab", and one with
 * both is ''. Alt with an arrow isn't named: Alt+←/→ are Go back / forward (`nav/input.ts`).
 * Letters follow the layout the way 1B's `matchesLetter` does (`letterOf`: by character, else by
 * key position); digits and punctuation by key position, so Shift (or Option) doesn't rename them.
 */
export function comboOf(e: Pick<KeyboardEvent, 'ctrlKey' | 'shiftKey' | 'altKey' | 'metaKey' | 'key' | 'code'> & { isComposing?: boolean }): string {
  if (e.isComposing || MODIFIERS.has(e.key)) return '';
  if (e.metaKey && (e.ctrlKey || !isMac())) return '';
  const mod = e.metaKey ? 'Cmd' : e.ctrlKey ? 'Ctrl' : null;
  const digit = /^Digit\d$/.test(e.code) ? e.code.slice(5) : null;
  if (!mod) {
    if (FUNCTION_KEY.test(e.key)) return [e.altKey && 'Alt', e.shiftKey && 'Shift', e.key].filter(Boolean).join('+');
    return e.altKey && digit ? ['Alt', e.shiftKey && 'Shift', digit].filter(Boolean).join('+') : '';
  }
  const letter = letterOf(e);
  let key = e.key;
  if (letter) key = letter.toUpperCase();
  else if (digit) key = digit;
  else if (CODE_NAMES[e.code]) key = CODE_NAMES[e.code];
  return [mod, e.altKey && 'Alt', e.shiftKey && 'Shift', key].filter(Boolean).join('+');
}

/**
 * Chords the browser (CEF included) would act on itself when nothing in the app takes them:
 * Ctrl+P prints, Ctrl+O opens a file picker, Ctrl+S saves the page (ruling R6), Ctrl+W closes the
 * browser tab (with no tab open, nothing in the app closes); Cmd on macOS. Their default is always
 * prevented, even behind an open menu, whether or not an action is bound to them now.
 */
const BROWSER_CHORDS = ['Mod+P', 'Mod+O', 'Mod+S', 'Mod+W'];

/** In the key router's `menu` layer: never claims, only stops the browser's own chords. */
const blockBrowserChords: KeyHandler = (e) => {
  if (BROWSER_CHORDS.map(resolveChord).includes(comboOf(e))) e.preventDefault();
};

/**
 * In the `app` layer (ruling R6: 1B's key router is the one dispatcher): a chord bound to a usable
 * action runs it and goes no further. So an open menu (the `menu` layer) or anything above
 * claims its keys first, and within the app layer, the only Ctrl+W binding is here (it closes
 * the open file if there is one, else the tab; `coreActions.ts`). Ctrl chords work even while
 * typing in a text box (spec §11.1), except where the action yields to the focused element
 * (`Action.yieldsTo`: Ctrl+Z belongs to a text box's own undo, spec #2 §5.5; Ctrl+Enter, to a
 * field that submits). The function keys (F8) and Alt+digit (the focus keys) dispatch here too;
 * an action whose keys another handler takes (`Action.keysBy`: F7, Alt+←) never matches.
 */
export const shortcutKeys: KeyHandler = (e) => {
  const action = actionForCombo(comboOf(e));
  if (!action) return;
  if (action.yieldsTo?.(e.target)) return;
  e.preventDefault();
  // A held combo repeats the action but logs only its first press (no log line per repeat).
  invoke(action, { quiet: e.repeat });
  return 'handled';
};

/** Installs the global shortcuts; returns their removal. */
export function installShortcuts(): () => void {
  const offGuard = registerKeys('menu', blockBrowserChords);
  const offKeys = registerKeys('app', shortcutKeys);
  return () => {
    offGuard();
    offKeys();
  };
}

/** The global Ctrl shortcuts (spec §11.1 table; Cmd on macOS), and the macOS menu bar's items
 * (`nativeMenu.ts`), while the app shell is mounted. */
export function useGlobalShortcuts(): void {
  useEffect(() => {
    const offKeys = installShortcuts();
    const offMenu = installNativeMenu();
    return () => {
      offKeys();
      offMenu();
    };
  }, []);
}
