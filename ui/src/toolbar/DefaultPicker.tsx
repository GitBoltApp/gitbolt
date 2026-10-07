import { useLayoutEffect, useRef, useState } from 'react';
import { pointInRect, swallowGestureClick } from '../ui/swallowClick';
import type { ToolbarPicker } from './registry';

/** The caret's default picker (spec #2 §12.1), anchored under the caret. ↑/↓ move, Enter or a
 * click picks (and closes), Esc or a click outside closes. Its keys are its own while it's
 * focused (a modal-like popover; the key router leaves a focused menu alone). */
export function DefaultPicker({ picker, anchor, onClose }: { picker: ToolbarPicker; anchor: Element; onClose: () => void }) {
  const value = picker.useValue();
  const [active, setActive] = useState(Math.max(0, picker.options.findIndex((o) => o.value === value)));
  const ref = useRef<HTMLDivElement>(null);
  const r = anchor.getBoundingClientRect();
  // Focus the menu; on close, hand focus back to the caret that opened it. (Its keys stay its own:
  // useModalKeys would claim Enter too.)
  useLayoutEffect(() => {
    const opener = document.activeElement;
    ref.current?.focus();
    return () => { if (opener instanceof HTMLElement) opener.focus(); };
  }, [ref]);
  // Clamp into the viewport once its size is known.
  const [pos, setPos] = useState({ left: r.left, top: r.bottom });
  useLayoutEffect(() => {
    const m = ref.current?.getBoundingClientRect();
    if (!m) return;
    setPos({ left: Math.max(0, Math.min(r.left, window.innerWidth - m.width)), top: Math.max(0, Math.min(r.bottom, window.innerHeight - m.height)) });
  }, [ref, r.left, r.bottom]);
  const pick = (v: string) => {
    picker.set(v);
    onClose();
  };
  return (
    <div
      className="tb-default-picker-backdrop"
      onPointerDown={(e) => {
        // A press on the caret that opened it (under the backdrop) toggles it closed: its click mustn't reopen it.
        if (pointInRect(e, anchor.getBoundingClientRect())) swallowGestureClick((c) => pointInRect(c, anchor.getBoundingClientRect()));
        onClose();
      }}
    >
      <div
        ref={ref}
        className="tb-default-picker"
        role="menu"
        aria-label={picker.title}
        tabIndex={-1}
        style={pos}
        onPointerDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          const n = picker.options.length;
          if (e.key === 'ArrowDown') setActive((a) => (a + 1) % n);
          else if (e.key === 'ArrowUp') setActive((a) => (a - 1 + n) % n);
          else if (e.key === 'Enter') pick(picker.options[active].value);
          else if (e.key === 'Escape') onClose();
          else return;
          e.preventDefault();
          e.stopPropagation();
        }}
      >
        <div className="tb-default-picker-title">{picker.title}</div>
        {picker.options.map((o, i) => {
          const on = o.value === value;
          return (
            <div key={o.value} role="menuitemradio" aria-checked={on} data-active={i === active} className="tb-default-picker-row" onPointerEnter={() => setActive(i)} onClick={() => pick(o.value)}>
              <span className="tb-radio" data-on={on} aria-hidden />
              {o.label}
            </div>
          );
        })}
      </div>
    </div>
  );
}
