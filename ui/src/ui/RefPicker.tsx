import type { LucideIcon } from 'lucide-react';
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { HoverTooltip } from './HoverTooltip';
import { useKeys } from './keyRouter';
import './picker.css';

export interface PickItem { id: string; label: string; detail?: string; icon?: LucideIcon; current?: boolean; tooltip?: string }

interface Props {
  /** The box it opens under (the button's `getBoundingClientRect()`). */
  anchor: DOMRect;
  items: PickItem[];
  placeholder: string;
  onPick(item: PickItem): void;
  onClose(): void;
  /** The element that opened it: a press on it doesn't count as "outside" (so its own click can
   * toggle the picker closed instead of closing and reopening it). */
  ignore?: Element | null;
}

const WIDTH = 300;

/** The open pickers' `onClose`s: something that takes the keyboard over (the auth modal) closes
 * them, so only one thing owns the key router's `menu` layer at a time. */
const openPickers = new Set<{ close(): void }>();
export function closePickers(): void {
  for (const p of [...openPickers]) p.close();
}

/**
 * A small searchable list anchored under a button: the toolbar's branch picker, the graph
 * header's pin picker (Task 16). Typing filters by case-insensitive substring; ↑/↓ move, Enter
 * picks, Esc closes; a press outside closes it.
 *
 * While open it owns the keyboard, as a menu does: it's in the key router's `menu` layer (ruling
 * R6), so no key reaches the app behind it. Esc closes the picker and nothing else, never the open
 * file too (J4), and Ctrl+W or F7 do nothing behind it. Every other key goes on to the search box.
 */
export function RefPicker({ anchor, items, placeholder, onPick, onClose, ignore }: Props) {
  const [q, setQ] = useState('');
  const [cursor, setCursor] = useState(0);
  const ref = useRef<HTMLDivElement>(null);
  const uid = useId();
  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return needle ? items.filter((i) => i.label.toLowerCase().includes(needle)) : items;
  }, [items, q]);
  // Before paint: the first frame already shows the current item selected, not the first one.
  useLayoutEffect(() => { setCursor(Math.max(0, shown.findIndex((i) => i.current))); }, [shown]);
  useEffect(() => {
    document.getElementById(`${uid}-${cursor}`)?.scrollIntoView?.({ block: 'nearest' });
  }, [uid, cursor]);
  useEffect(() => {
    const entry = { close: onClose };
    openPickers.add(entry);
    return () => { openPickers.delete(entry); };
  }, [onClose]);
  useLayoutEffect(() => {
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!ref.current?.contains(t) && !ignore?.contains(t)) onClose();
    };
    window.addEventListener('pointerdown', onDown, true);
    return () => window.removeEventListener('pointerdown', onDown, true);
  }, [onClose, ignore]);

  useKeys('menu', (e) => {
    const plain = !e.ctrlKey && !e.altKey && !e.metaKey && !e.isComposing;
    if (plain && e.key === 'ArrowDown') setCursor((c) => Math.min(shown.length - 1, c + 1));
    else if (plain && e.key === 'ArrowUp') setCursor((c) => Math.max(0, c - 1));
    else if (plain && e.key === 'Enter') { if (shown[cursor]) onPick(shown[cursor]); }
    else if (e.key === 'Escape') onClose();
    else return 'native';
    e.preventDefault();
    return 'handled';
  });

  const left = Math.max(4, Math.min(anchor.left, window.innerWidth - WIDTH - 4));
  return createPortal(
    <div ref={ref} className="picker" style={{ left, top: anchor.bottom + 4 }}>
      <input
        autoFocus
        className="picker-input"
        placeholder={placeholder}
        aria-label={placeholder}
        role="combobox"
        aria-expanded
        aria-controls={`${uid}-list`}
        aria-activedescendant={shown[cursor] ? `${uid}-${cursor}` : undefined}
        spellCheck={false}
        autoComplete="off"
        value={q}
        onChange={(e) => setQ(e.target.value)}
      />
      <div className="picker-list" role="listbox" id={`${uid}-list`} aria-label={placeholder}>
        {shown.map((item, i) => {
          const Icon = item.icon;
          const row = (
            <div
              key={item.id}
              id={`${uid}-${i}`}
              role="option"
              aria-selected={i === cursor}
              data-current={item.current || undefined}
              className="picker-item"
              onPointerEnter={() => setCursor(i)}
              onClick={() => onPick(item)}
            >
              {Icon && <Icon size={13} aria-hidden />}
              <span className="picker-label">{item.label}</span>
              {item.detail && <span className="picker-detail">{item.detail}</span>}
            </div>
          );
          return item.tooltip ? <HoverTooltip key={item.id} content={item.tooltip}>{row}</HoverTooltip> : row;
        })}
        {shown.length === 0 && <div className="picker-empty">No matches</div>}
      </div>
    </div>,
    document.body,
  );
}
