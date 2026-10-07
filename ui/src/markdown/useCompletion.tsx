import { useEffect, useId, useMemo, useState, type KeyboardEvent, type ReactElement, type ReactNode, type RefObject } from 'react';
import { escOwners } from '../app/modalKeys';
import { insertToken, MAX_HITS, type Trigger } from './emojiComplete';

const MIRRORED = ['direction', 'boxSizing', 'width', 'height', 'overflowX', 'overflowY', 'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth', 'borderStyle', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'fontStyle', 'fontVariant', 'fontWeight', 'fontStretch', 'fontSize', 'lineHeight', 'fontFamily', 'textAlign', 'textTransform', 'textIndent', 'letterSpacing', 'wordSpacing', 'tabSize', 'whiteSpace', 'wordWrap', 'overflowWrap'] as const;

/** The viewport position (left, and the bottom of the line) of the character at `index`, found
 * by laying the text before it out in an off-screen copy of the textarea. */
export function caretPoint(area: HTMLTextAreaElement, index: number): { left: number; bottom: number } {
  const style = getComputedStyle(area);
  const mirror = document.createElement('div');
  for (const p of MIRRORED) mirror.style[p] = style[p];
  mirror.style.position = 'absolute';
  mirror.style.visibility = 'hidden';
  mirror.style.top = '0';
  mirror.style.left = '-9999px';
  mirror.style.whiteSpace = 'pre-wrap';
  mirror.style.overflow = 'hidden';
  mirror.textContent = area.value.slice(0, index);
  const mark = document.createElement('span');
  mark.textContent = '​';
  mirror.append(mark);
  document.body.append(mirror);
  const line = parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.5 || 18;
  const x = mark.offsetLeft - area.scrollLeft;
  const y = mark.offsetTop - area.scrollTop;
  mirror.remove();
  const box = area.getBoundingClientRect();
  return { left: box.left + x, bottom: box.top + y + line };
}

/** One kind of completion: a trigger character and where its candidates come from. */
export interface Provider<T> {
  /** The popup's accessible name ("Emoji", "People"). */
  label: string;
  find(text: string, caret: number): Trigger | null;
  /** Candidates known now, best first. */
  local(query: string): T[];
  /** More candidates from a slow source (asked after a short debounce); optional. */
  remote?(query: string): Promise<T[]>;
  /** Called when the trigger first shows (to load the data). */
  prepare?(): void;
  key(item: T): string;
  /** The text that replaces the trigger and query (with its trailing space). */
  token(item: T): string;
  row(item: T): ReactNode;
}

export const REMOTE_DEBOUNCE_MS = 150;

export interface Completion {
  /** Handles a key for the popup; true when it was the popup's (the caller then does nothing). */
  keyDown(e: KeyboardEvent<HTMLElement>): boolean;
  /** Tell it the text or caret changed. */
  sync(): void;
  /** Props for the textarea (it keeps its textbox role, so it keeps its name in queries). */
  aria: { 'aria-autocomplete': 'list'; 'aria-expanded': boolean; 'aria-controls'?: string; 'aria-activedescendant'?: string };
  popup: ReactElement | null;
}

/** Autocomplete for a controlled textarea from `providers` (the first whose trigger is at the
 * caret wins): the popup at the caret, ↑/↓, Enter/Tab to insert, Esc to close. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function useCompletion(area: RefObject<HTMLTextAreaElement | null>, value: string, onChange: (v: string) => void, providers: readonly (Provider<any> | null)[]): Completion {
  const id = useId();
  const [caret, setCaret] = useState(0);
  const [active, setActive] = useState(0);
  const [closedAt, setClosedAt] = useState<number | null>(null);
  const found = useMemo(() => {
    for (let i = 0; i < providers.length; i++) {
      const t = providers[i]?.find(value, caret) ?? null;
      if (t) return { i, t };
    }
    return null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, caret, ...providers]);
  const provider = found ? providers[found.i]! : null;
  const trigger = found?.t ?? null;
  const query = trigger?.query;
  const which = found?.i;
  useEffect(() => { if (found) provider?.prepare?.(); }, [found !== null, provider]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (!trigger) setClosedAt(null); }, [trigger]);
  useEffect(() => setActive(0), [query, which]);

  const [more, setMore] = useState<{ tag: string; items: unknown[] }>({ tag: '', items: [] });
  const tag = `${which}:${query}`;
  const remote = provider?.remote;
  useEffect(() => {
    if (!remote || query === undefined) return;
    let live = true;
    const t = setTimeout(() => {
      remote(query).then((items) => { if (live) setMore({ tag, items }); }, () => undefined);
    }, REMOTE_DEBOUNCE_MS);
    return () => { live = false; clearTimeout(t); };
  }, [remote, query, tag]);

  const items = useMemo(() => {
    if (!provider || query === undefined) return [];
    const local = provider.local(query);
    const seen = new Set(local.map((x) => provider.key(x)));
    const extra = more.tag === tag ? more.items.filter((x) => !seen.has(provider.key(x))) : [];
    return [...local, ...extra].slice(0, MAX_HITS);
  }, [provider, query, more, tag]);
  const open = trigger !== null && items.length > 0 && closedAt !== trigger.start;
  const optionId = (i: number) => `${id}-opt-${i}`;
  const current = Math.min(active, items.length - 1);

  const start = trigger?.start;
  // An open popup owns Esc inside a dialog (the MR view): it closes the popup, not the dialog.
  const openAt = open ? start : undefined;
  useEffect(() => {
    if (openAt === undefined) return;
    const own = () => { setClosedAt(openAt); return true; };
    escOwners.add(own);
    return () => { escOwners.delete(own); };
  }, [openAt]);

  const [point, setPoint] = useState<{ left: number; bottom: number } | null>(null);
  useEffect(() => {
    const a = area.current;
    setPoint(open && a && start !== undefined ? caretPoint(a, start) : null);
  }, [open, start, value, area]);

  const sync = () => {
    const a = area.current;
    if (a) setCaret(a.selectionStart);
  };
  const insert = (item: unknown) => {
    const a = area.current;
    if (!a || !trigger || !provider) return;
    const r = insertToken(value, a.selectionStart, trigger, provider.token(item));
    onChange(r.text);
    setCaret(r.caret);
    requestAnimationFrame(() => { a.focus(); a.setSelectionRange(r.caret, r.caret); });
  };
  const keyDown = (e: KeyboardEvent<HTMLElement>): boolean => {
    if (!open || e.ctrlKey || e.metaKey || e.altKey) return false;
    const stop = () => { e.preventDefault(); e.stopPropagation(); };
    switch (e.key) {
      case 'ArrowDown': stop(); setActive((i) => (i + 1) % items.length); return true;
      case 'ArrowUp': stop(); setActive((i) => (i - 1 + items.length) % items.length); return true;
      case 'Enter':
      case 'Tab': stop(); insert(items[current]); return true;
      case 'Escape': stop(); setClosedAt(trigger!.start); return true;
      default: return false;
    }
  };
  const popup = open && point && provider ? (
    <ul id={`${id}-list`} className="md-emoji-pop" role="listbox" aria-label={provider.label} style={{ left: point.left, top: point.bottom + 2 }} onMouseDown={(e) => e.preventDefault()}>
      {items.map((it, i) => (
        <li key={provider.key(it)} id={optionId(i)} role="option" aria-selected={i === current} className="md-emoji-opt" onMouseEnter={() => setActive(i)} onClick={() => insert(it)}>
          {provider.row(it)}
        </li>
      ))}
    </ul>
  ) : null;
  return {
    keyDown,
    sync,
    aria: { 'aria-autocomplete': 'list', 'aria-expanded': open, ...(open ? { 'aria-controls': `${id}-list`, 'aria-activedescendant': optionId(current) } : {}) },
    popup,
  };
}
