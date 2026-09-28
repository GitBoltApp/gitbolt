type KeyLike = { key: string; code: string; ctrlKey: boolean; altKey: boolean; metaKey: boolean; shiftKey: boolean };

/**
 * Whether a key event is `letter` (lower-case a-z). By character when `e.key` is a Latin letter,
 * so Dvorak and AZERTY users press the letter printed on their key; by key position (`e.code`)
 * otherwise, so on a non-Latin layout (Cyrillic, Greek, …) the chord still works.
 */
export function matchesLetter(e: Pick<KeyLike, 'key' | 'code'>, letter: string): boolean {
  const k = e.key.toLowerCase();
  return /^[a-z]$/.test(k) ? k === letter : e.code === `Key${letter.toUpperCase()}`;
}

/** Ctrl+W: closes the open file, as Esc does, even with an editor overlay open (as VS Code
 * does); plan 1C makes it close the tab. It's a Chrome-reserved chord: the CEF runtime lets it
 * reach the page (vendor/tauri-runtime-cef/GITBOLT-PATCH.md). */
export const isCloseFileKey = (e: KeyLike) => e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey && matchesLetter(e, 'w');

const editorKeys = new WeakSet<Event>();
/** Marks a key event an editor overlay owns (Esc closing Monaco's hover, find, menu, …), for
 * handlers further up that would otherwise act on it too. */
export const markEditorKey = (e: Event) => void editorKeys.add(e);
export const isEditorKey = (e: Event) => editorKeys.has(e);
