import { Check, ChevronDown, type LucideIcon } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { openMenuAt, useMenu } from '../menu/menuStore';
import type { MenuRow } from '../menu/types';
import { registerKeys } from './keyRouter';
import './select.css';

/** No icon: the unselected rows line up with the selected row's check. */
const Blank = (() => null) as unknown as LucideIcon;

export interface SelectProps<T extends string | number> {
  id?: string;
  value: T;
  /** `[value, label]`, or `[value, label, tooltip]`: the open list's row tooltip (default: the label). */
  options: ReadonlyArray<readonly [T, string] | readonly [T, string, string]>;
  onChange(v: T): void;
  /** What the button shows in place of the chosen option's label (Create's "Template: none"). */
  shown?: ReactNode;
  'aria-label'?: string;
  'aria-labelledby'?: string;
}

/**
 * A dropdown that is the app's own menu (`openMenuAt`), not a native `<select>`: the native popup
 * is a separate OS-level window that CEF on Linux dismisses at once (its focus bounce, K24), so it
 * never stayed open. Enter / Space (the button's click) and ArrowDown / ArrowUp open it; the menu
 * takes the arrows, Enter and Esc, and gives focus back here.
 */
export function Select<T extends string | number>({ id, value, options, onChange, shown, ...rest }: SelectProps<T>) {
  const btn = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [focused, setFocused] = useState(false);
  const rows = (): MenuRow[] => options.map(([v, l, tip]) => ({
    kind: 'action', id: `select.${v}`, label: l, icon: v === value ? Check : Blank, tooltip: tip ?? l, run: () => onChange(v),
  }));
  const show = () => setOpen(openMenuAt(btn.current!, rows(), `select.${value}`, rows, rest['aria-label']));
  useEffect(() => useMenu.subscribe((s) => { if (s.rows === null) setOpen(false); }), []);
  // The key router claims every key before React sees it, so the arrows are taken here.
  const showRef = useRef(show);
  showRef.current = show;
  useEffect(() => {
    if (!focused) return;
    return registerKeys('menu', (e) => {
      if (e.target !== btn.current || useMenu.getState().rows) return;
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
      e.preventDefault();
      showRef.current();
      return 'handled';
    });
  }, [focused]);
  const current = options.find(([v]) => v === value)?.[1] ?? String(value);
  return (
    <button
      ref={btn}
      id={id}
      type="button"
      className="select"
      aria-haspopup="menu"
      aria-expanded={open}
      aria-label={rest['aria-label']}
      aria-labelledby={rest['aria-labelledby']}
      onClick={show}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
    >
      <span className="select-value">{shown ?? current}</span>
      <ChevronDown size={14} aria-hidden className="select-caret" />
    </button>
  );
}
