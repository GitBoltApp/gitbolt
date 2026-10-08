import { Keyboard, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { create } from 'zustand';
import { useModalKeys } from '../app/modalKeys';
import { comboOf } from '../app/shortcuts';
import { registerKeys } from '../ui/keyRouter';
import { filterSections, shortcutSections } from './catalog';
import './shortcuts.css';
import { chordKeycaps, displayChord, resolveChord } from '../ui/platformKeys';

export const useShortcutsUi = create<{ open: boolean; setOpen: (o: boolean) => void }>((set) => ({ open: false, setOpen: (open) => set({ open }) }));
const close = () => useShortcutsUi.getState().setOpen(false);

const Keys = ({ chord }: { chord: string }) => (
  <span className="sc-chord">{chordKeycaps(chord).map((k, i) => <kbd key={i} className="sc-key">{k}</kbd>)}</span>
);

/** Ctrl+/: the Keyboard Shortcuts panel, built from the app's real registrations (`catalog.ts`). */
export function ShortcutsPanel() {
  const open = useShortcutsUi((s) => s.open);
  const ref = useModalKeys<HTMLDivElement>(open, close);
  const input = useRef<HTMLInputElement>(null);
  const [q, setQ] = useState('');
  useEffect(() => {
    if (!open) return;
    setQ('');
    // The modal claims every key in the menu layer; Ctrl+/ (toggle) and Ctrl+F (filter) are its own.
    return registerKeys('menu', (e) => {
      const c = comboOf(e);
      if (c === resolveChord('Mod+/')) { e.preventDefault(); close(); return 'handled'; }
      if (c === resolveChord('Mod+F')) { e.preventDefault(); input.current?.focus(); input.current?.select(); return 'handled'; }
    });
  }, [open]);
  const sections = useMemo(() => (open ? filterSections(shortcutSections(), q) : []), [open, q]);
  if (!open) return null;
  return (
    <div className="modal-backdrop" onPointerDown={close}>
      <div ref={ref} className="modal sc-modal" role="dialog" aria-modal="true" aria-label="Keyboard Shortcuts" onPointerDown={(e) => e.stopPropagation()}>
        <div className="sc-head">
          <h2><Keyboard size={16} aria-hidden />Keyboard Shortcuts <Keys chord="Mod+/" /></h2>
          <input ref={input} autoFocus type="search" className="sc-filter" placeholder={`Filter shortcuts (${displayChord('Mod+F')})`} aria-label="Filter shortcuts" value={q} onChange={(e) => setQ(e.target.value)} />
          <button type="button" className="icon-button" aria-label="Close shortcuts" onClick={close}><X size={14} /></button>
        </div>
        <div className="sc-body">
          {sections.length === 0 && <div className="sc-empty">No shortcuts match.</div>}
          {sections.map((s) => (
            <section key={s.title} aria-label={s.title}>
              <h3>{s.title}</h3>
              <ul>
                {s.rows.map((r) => (
                  <li key={r.id} className="sc-row">
                    <span className="sc-label">{r.label}{r.context && <span className="sc-ctx"> {r.context}</span>}</span>
                    <span className="sc-keys">{r.keys.map((k, i) => <span key={k} className="sc-alt">{i > 0 && <span className="sc-or">or</span>}<Keys chord={k} /></span>)}</span>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}
