import { useEffect } from 'react';
import { registerKeys, type KeyHandler } from '../ui/keyRouter';
import { letterOf } from '../ui/keys';
import { actionForCombo, invoke } from './actions';

const CODE_NAMES: Record<string, string> = { Comma: ',', Equal: '=', Minus: '-', Period: '.', Slash: '/', Backquote: '`', BracketLeft: '[', BracketRight: ']', Semicolon: ';', Quote: "'", Backslash: '\\' };
const MODIFIERS = new Set(['Control', 'Shift', 'Alt', 'Meta', 'AltGraph', 'OS']);

/**
 * "Ctrl+Shift+T" for a Ctrl chord; '' for anything else (no Ctrl, a Super/Meta chord, a lone
 * modifier, IME composition). Letters follow the layout the way 1B's `matchesLetter` does
 * (`letterOf`: by character, else by key position); digits and punctuation by key position, so
 * Shift doesn't rename them.
 */
export function comboOf(e: Pick<KeyboardEvent, 'ctrlKey' | 'shiftKey' | 'altKey' | 'metaKey' | 'key' | 'code'> & { isComposing?: boolean }): string {
  if (!e.ctrlKey || e.metaKey || e.isComposing || MODIFIERS.has(e.key)) return '';
  const letter = letterOf(e);
  let key = e.key;
  if (letter) key = letter.toUpperCase();
  else if (/^Digit\d$/.test(e.code)) key = e.code.slice(5);
  else if (CODE_NAMES[e.code]) key = CODE_NAMES[e.code];
  return ['Ctrl', e.altKey && 'Alt', e.shiftKey && 'Shift', key].filter(Boolean).join('+');
}

/**
 * Chords the browser (CEF included) would act on itself when nothing in the app takes them:
 * Ctrl+P prints, Ctrl+O opens a file picker, Ctrl+S saves the page (ruling R6), Ctrl+W closes the
 * browser tab (with no tab open, nothing in the app closes). Their default is always prevented,
 * even behind an open menu, whether or not an action is bound to them now.
 */
const BROWSER_CHORDS = new Set(['Ctrl+P', 'Ctrl+O', 'Ctrl+S', 'Ctrl+W']);

/** In the key router's `menu` layer: never claims, only stops the browser's own chords. */
const blockBrowserChords: KeyHandler = (e) => {
  if (BROWSER_CHORDS.has(comboOf(e))) e.preventDefault();
};

/**
 * In the `app` layer (ruling R6: 1B's key router is the one dispatcher): a chord bound to a usable
 * action runs it and goes no further. So an open menu (the `menu` layer) or anything above
 * claims its keys first, and within the app layer, the only Ctrl+W binding is here (it closes
 * the open file if there is one, else the tab; `coreActions.ts`). Ctrl chords work even while
 * typing in a text box (spec §11.1).
 */
export const shortcutKeys: KeyHandler = (e) => {
  const action = actionForCombo(comboOf(e));
  if (!action) return;
  e.preventDefault();
  invoke(action);
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

/** The global Ctrl shortcuts (spec §11.1 table), while the app shell is mounted. */
export function useGlobalShortcuts(): void {
  useEffect(installShortcuts, []);
}
