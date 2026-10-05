import { useEffect, useId, useRef, useState, type KeyboardEvent, type MutableRefObject, type Ref } from 'react';

export interface HostSuggestion { host: string; source: string }

interface Props {
  value: string;
  suggestions: HostSuggestion[];
  onChange(host: string): void;
  inputRef?: Ref<HTMLInputElement>;
  /** Reports whether the suggestion list is open, so the panel's Esc closes the list first. */
  onOpenChange?(open: boolean): void;
  /** Filled with a function that closes the list (the router's Esc never reaches onKeyDown). */
  closeRef?: MutableRefObject<(() => void) | null>;
}

/**
 * A host box with a suggestion list (the open repo's forge hosts, each with where it came from).
 * Typing any host is fine. Arrows move, Enter picks, Esc closes the list. The list floats
 * (absolute), so opening it shifts nothing.
 */
export function HostCombobox({ value, suggestions, onChange, inputRef, onOpenChange, closeRef }: Props) {
  const [open, setOpen] = useState(false);
  if (closeRef) closeRef.current = () => setOpen(false);
  const [cursor, setCursor] = useState(0);
  const uid = useId();
  const q = value.trim().toLowerCase();
  // A value that is itself a suggestion (the prefilled host) shows them all, to switch to another.
  const exact = suggestions.some((s) => s.host === value);
  const shown = exact ? suggestions : suggestions.filter((s) => !q || s.host.toLowerCase().includes(q));
  const listOpen = open && shown.length > 0 && !(shown.length === 1 && exact);
  const reported = useRef(listOpen);
  useEffect(() => {
    if (reported.current !== listOpen) { reported.current = listOpen; onOpenChange?.(listOpen); }
  }, [listOpen, onOpenChange]);
  const pick = (h: string) => { onChange(h); setOpen(false); };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setOpen(true); setCursor((c) => Math.min(c + 1, shown.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setCursor((c) => Math.max(c - 1, 0)); }
    else if (e.key === 'Enter' && listOpen && shown[cursor]) { e.preventDefault(); pick(shown[cursor].host); }
    else if (e.key === 'Escape' && listOpen) { e.stopPropagation(); setOpen(false); }
  };
  return (
    <div className="host-combo">
      <input
        ref={inputRef}
        role="combobox"
        aria-label="Host"
        aria-expanded={listOpen}
        aria-controls={`${uid}-list`}
        aria-autocomplete="list"
        aria-activedescendant={listOpen && shown[cursor] ? `${uid}-opt-${cursor}` : undefined}
        placeholder="gitlab.example.com"
        spellCheck={false}
        autoComplete="off"
        value={value}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onChange={(e) => { onChange(e.target.value); setOpen(true); setCursor(0); }}
        onKeyDown={onKey}
      />
      {listOpen && (
        <ul id={`${uid}-list`} role="listbox" aria-label="Hosts of this repository" className="host-combo-list">
          {shown.map((s, i) => (
            <li key={s.host} id={`${uid}-opt-${i}`} role="option" aria-selected={i === cursor} className={i === cursor ? 'is-active' : undefined} onMouseDown={(e) => { e.preventDefault(); pick(s.host); }}>
              <span>{s.host}</span> <small className="dim">{s.source}</small>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
