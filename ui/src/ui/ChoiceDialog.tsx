import { useState } from 'react';
import { create } from 'zustand';
import { useModalKeys } from '../app/modalKeys';
import './choice.css';

/** One button of a choice dialog. */
export interface Choice { id: string; label: string; primary?: boolean; danger?: boolean; /** Greyed: the body says why (a refused rebase, 2D T18). */ disabled?: boolean }
export interface ChoiceRequest {
  title: string;
  body: string;
  /** A second paragraph (a conflict preview), shown only when set. */
  note?: string;
  choices: Choice[];
  /** One option beside the choices ("Also move 2 stacked branches"). */
  checkbox?: { label: string; checked: boolean; detail?: string };
}
export interface ChoiceResult { choice: string | null; checked: boolean }

interface Pending extends ChoiceRequest { resolve(r: ChoiceResult): void }
const useChoiceStore = create<{ pending: Pending | null }>(() => ({ pending: null }));

/**
 * A question with several answers (spec #2 §12.2's Rebase / Merge / Cancel, §13.1's confirmation
 * with the stacked-branches checkbox). Cancel is always last and takes the initial focus; Cancel,
 * Esc, the backdrop or a newer request resolve `{ choice: null }`. Mount `<ChoiceDialog />` once.
 */
export function askChoice(req: ChoiceRequest): Promise<ChoiceResult> {
  useChoiceStore.getState().pending?.resolve({ choice: null, checked: false });
  return new Promise((resolve) => useChoiceStore.setState({ pending: { ...req, resolve } }));
}

export function ChoiceDialog() {
  const pending = useChoiceStore((s) => s.pending);
  if (!pending) return null;
  return <ChoiceForm pending={pending} key={pending.title + pending.body} />;
}

function ChoiceForm({ pending }: { pending: Pending }) {
  const [checked, setChecked] = useState(pending.checkbox?.checked ?? false);
  const done = (choice: string | null) => {
    useChoiceStore.setState({ pending: null });
    pending.resolve({ choice, checked: choice === null ? false : checked });
  };
  const ref = useModalKeys<HTMLDivElement>(true, () => done(null));
  return (
    <div className="modal-backdrop" onPointerDown={() => done(null)}>
      <div ref={ref} className="modal" role="alertdialog" aria-modal="true" aria-labelledby="choice-title" aria-describedby="choice-body" onPointerDown={(e) => e.stopPropagation()}>
        <h2 id="choice-title">{pending.title}</h2>
        <p id="choice-body">{pending.body}</p>
        {pending.note && <p className="modal-note">{pending.note}</p>}
        {pending.checkbox && (
          <label className="modal-check">
            <input type="checkbox" checked={checked} onChange={(e) => setChecked(e.target.checked)} />
            {pending.checkbox.label}
            {pending.checkbox.detail && <span className="modal-check-detail"> ({pending.checkbox.detail})</span>}
          </label>
        )}
        <div className="modal-actions choice-actions">
          <button type="button" className="choice-cancel" autoFocus onClick={() => done(null)}>Cancel</button>
          {pending.choices.map((c) => (
            <button key={c.id} type="button" disabled={c.disabled} className={c.danger ? 'danger' : c.primary ? 'primary' : undefined} onClick={() => done(c.id)}>{c.label}</button>
          ))}
        </div>
      </div>
    </div>
  );
}
