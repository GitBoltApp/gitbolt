type KeyLike = { key: string; code: string; ctrlKey: boolean; altKey: boolean; metaKey: boolean; shiftKey: boolean };

/**
 * The letter (lower-case a-z) a key event is, for shortcuts; null for any other key. By
 * character when `e.key` is a Latin letter, so Dvorak and AZERTY users press the letter printed
 * on their key; by key position (`e.code`) otherwise, so on a non-Latin layout (Cyrillic, Greek,
 * …) the chord still works. The app's Ctrl shortcuts are named by it (`app/shortcuts.ts`).
 */
export function letterOf(e: Pick<KeyLike, 'key' | 'code'>): string | null {
  const k = e.key.toLowerCase();
  if (/^[a-z]$/.test(k)) return k;
  return /^Key[A-Z]$/.test(e.code) ? e.code.slice(3).toLowerCase() : null;
}

/** Whether a key event is `letter` (lower-case a-z), as `letterOf` reads it. */
export function matchesLetter(e: Pick<KeyLike, 'key' | 'code'>, letter: string): boolean {
  return letterOf(e) === letter;
}

const editorKeys = new WeakSet<Event>();
/** Marks a key event an editor overlay owns (Esc closing Monaco's hover, find, menu, …), for
 * handlers further up that would otherwise act on it too. */
export const markEditorKey = (e: Event) => void editorKeys.add(e);
export const isEditorKey = (e: Event) => editorKeys.has(e);

const TEXT_ENTRY = 'input:not([type]), input[type="text"], input[type="search"], input[type="email"], input[type="url"], input[type="tel"], input[type="password"], input[type="number"], textarea, select';
/** Whether `t` is an editable element (a text input, a textarea, a select or contenteditable
 * text) that owns the caret keys (arrows, Home/End, Space, Backspace) and pointer presses
 * inside it. App-level key and pointer handlers that act on bare keys ignore such targets. */
export function isEditableTarget(t: EventTarget | null): boolean {
  if (!(t instanceof Element)) return false;
  return t.matches(TEXT_ENTRY) || (t instanceof HTMLElement && t.isContentEditable === true);
}
