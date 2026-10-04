/**
 * Metadata for keys that are NOT app actions (`registerActions` shortcuts carry their own label and
 * group): the Esc handlers, F7, zoom, the rebase editor's letters, the message fields. Each key
 * registration site declares its hint next to the handler, so the Keyboard Shortcuts panel
 * (Ctrl+/) is built from what the app really binds. Metadata only; no behaviour.
 */
export interface KeyHint {
  id: string;
  /** The panel section heading. */
  section: string;
  label: string;
  /** Display chords, e.g. 'Shift+F7'; one keycap group each. */
  keys: string[];
  /** "(when in message input)"-style note for keys that only work in a context. */
  context?: string;
  /** The file (relative to ui/src) whose key handler this describes; `hints.test.ts` audits it. */
  source: string;
}

const hints = new Map<string, KeyHint>();

export function registerKeyHints(list: KeyHint[]): () => void {
  for (const h of list) hints.set(h.id, h);
  return () => { for (const h of list) if (hints.get(h.id) === h) hints.delete(h.id); };
}

export const keyHints = (): KeyHint[] => [...hints.values()];
