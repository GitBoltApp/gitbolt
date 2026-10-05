import { X } from 'lucide-react';
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { errorMessage } from '../../api/client';
import { debounce } from '../../util/debounce';
import { chipStyle } from '../chipStyle';
import { EmojiText } from '../emoji';
import './searchPicker.css';

export interface PickOption<T> { key: string; label: string; detail?: string; color?: string | null; value: T }
export const SEARCH_DEBOUNCE_MS = 250;

interface Props<T> {
  /** The search box's accessible name: `Reviewers`, `Assignees`, `Labels`. */
  label: string;
  chips: Array<{ key: string; label: string; color?: string | null }>;
  onRemove(key: string): void;
  search(query: string): Promise<Array<PickOption<T>>>;
  onPick(value: T): void;
}

/**
 * Chips and a search box (spec #4 §4 "4C": reviewers, assignees and labels with a debounced
 * search). Only the newest query's answer shows: a slower answer to an older one is dropped, and
 * typing hides the last answer until the new one comes, so Enter never picks from a stale list.
 * ↑/↓ move, Enter picks, Backspace in an empty box removes the last chip. Keys typed here never
 * reach the app's shortcuts.
 */
export function SearchPicker<T>({ label, chips, onRemove, search, onPick }: Props<T>) {
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const [options, setOptions] = useState<Array<PickOption<T>> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cursor, setCursor] = useState(0);
  const seq = useRef(0);
  const uid = useId();
  const listId = `${uid}-list`;
  const optId = (i: number) => `${uid}-opt-${i}`;
  const listRef = useRef<HTMLUListElement>(null);
  const searchRef = useRef(search);
  searchRef.current = search;
  const run = useMemo(() => debounce(async (query: string) => {
    const mine = ++seq.current;
    try {
      const found = await searchRef.current(query);
      if (mine === seq.current) { setOptions(found); setError(null); setCursor(0); }
    } catch (e) {
      if (mine === seq.current) { setOptions([]); setError(errorMessage(e)); }
    }
  }, SEARCH_DEBOUNCE_MS), []);
  useEffect(() => () => run.cancel(), [run]);
  const taken = new Set(chips.map((c) => c.key));
  const shown = (options ?? []).filter((o) => !taken.has(o.key));
  useEffect(() => {
    listRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView?.({ block: 'nearest' });
  }, [cursor, options]);
  const pick = (o: PickOption<T>) => {
    seq.current++;
    onPick(o.value);
    setQ('');
    setOptions(null);
    run('');
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    const listOpen = open && options !== null && !error;
    if (e.key === 'Escape') {
      if (open && options !== null) { e.stopPropagation(); setOpen(false); }
      return;
    }
    if (e.key === 'ArrowDown') { e.stopPropagation(); e.preventDefault(); setOpen(true); setCursor((c) => Math.min(c + 1, Math.max(shown.length - 1, 0))); }
    else if (e.key === 'ArrowUp') { e.stopPropagation(); e.preventDefault(); setCursor((c) => Math.max(c - 1, 0)); }
    else if (e.key === 'Enter' && listOpen && shown[cursor]) { e.stopPropagation(); e.preventDefault(); pick(shown[cursor]); }
    else if (e.key === 'Backspace' && !q && chips.length) { e.stopPropagation(); onRemove(chips[chips.length - 1].key); }
  };
  return (
    <div className="pick">
      <div className="pick-box">
        {chips.map((c) => (
          <span key={c.key} className="pick-chip" style={chipStyle(c.color)} data-colored={c.color ? '' : undefined}>
            <EmojiText text={c.label} />
            <button type="button" className="pick-remove" aria-label={`Remove ${c.label}`} onClick={() => onRemove(c.key)}><X size={12} /></button>
          </span>
        ))}
        <input
          role="combobox"
          aria-expanded={open && options !== null && !error}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={open && shown[cursor] ? optId(cursor) : undefined}
          aria-label={label}
          placeholder={label}
          value={q}
          spellCheck={false}
          autoComplete="off"
          onFocus={() => { setOpen(true); run(q); }}
          onBlur={() => setOpen(false)}
          onChange={(e) => { seq.current++; setQ(e.target.value); setOptions(null); setOpen(true); run(e.target.value); }}
          onKeyDown={onKey}
        />
      </div>
      {open && options !== null && !error && (
        <ul ref={listRef} id={listId} className="pick-list" role="listbox" aria-label={`${label} matches`}>
          {shown.map((o, i) => (
            <li
              key={o.key}
              id={optId(i)}
              role="option"
              aria-selected={i === cursor}
              style={chipStyle(o.color)}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => pick(o)}
            >
              {o.color && <span className="pick-dot" aria-hidden="true" />}<EmojiText text={o.label} />{o.detail && <span className="pick-detail"> {o.detail}</span>}
            </li>
          ))}
          {!shown.length && !error && <li className="pick-note" aria-disabled="true">No matches</li>}
        </ul>
      )}
      {error && <p className="pick-error" role="alert">{error}</p>}
    </div>
  );
}
