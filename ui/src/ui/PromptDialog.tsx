import { useState } from 'react';
import { create } from 'zustand';
import { useModalKeys } from '../app/modalKeys';

/** A one-field question (create branch, rename): a validated text box and an optional checkbox. */
export interface PromptRequest {
  title: string;
  label: string;
  initial?: string;
  confirmLabel: string;
  /** Live: the reason the value can't be used, or `null`. */
  validate?: (value: string) => string | null;
  checkbox?: { label: string; initial: boolean };
}
export interface PromptAnswer { value: string; checked: boolean }

interface Pending extends PromptRequest { id: number; resolve(a: PromptAnswer | null): void }
let nextId = 0;
const usePromptStore = create<{ pending: Pending | null }>(() => ({ pending: null }));

/** Asks; `null` on Cancel, Esc, a backdrop click or a newer request. Mount `<PromptDialog />` once. */
export function promptText(req: PromptRequest): Promise<PromptAnswer | null> {
  usePromptStore.getState().pending?.resolve(null);
  return new Promise((resolve) => usePromptStore.setState({ pending: { ...req, id: ++nextId, resolve } }));
}

export function PromptDialog() {
  const pending = usePromptStore((s) => s.pending);
  if (!pending) return null;
  return <PromptForm pending={pending} key={pending.id} />;
}

function PromptForm({ pending }: { pending: Pending }) {
  const [value, setValue] = useState(pending.initial ?? '');
  const [checked, setChecked] = useState(pending.checkbox?.initial ?? false);
  const error = pending.validate?.(value) ?? null;
  const done = (a: PromptAnswer | null) => {
    usePromptStore.setState({ pending: null });
    pending.resolve(a);
  };
  const ref = useModalKeys<HTMLDivElement>(true, () => done(null));
  const submit = () => { if (!error) done({ value, checked }); };
  return (
    <div className="modal-backdrop" onPointerDown={() => done(null)}>
      <div ref={ref} className="modal" role="dialog" aria-modal="true" aria-labelledby="prompt-title" onPointerDown={(e) => e.stopPropagation()}>
        <h2 id="prompt-title">{pending.title}</h2>
        <form onSubmit={(e) => { e.preventDefault(); submit(); }}>
          <label className="modal-field">
            <span>{pending.label}</span>
            <input autoFocus aria-label={pending.label} value={value} onChange={(e) => setValue(e.target.value)} spellCheck={false} />
          </label>
          {error && value && <p role="alert" className="modal-error">{error}</p>}
          {pending.checkbox && (
            <label className="modal-check">
              <input type="checkbox" checked={checked} onChange={(e) => setChecked(e.target.checked)} /> {pending.checkbox.label}
            </label>
          )}
          <div className="modal-actions">
            <button type="button" onClick={() => done(null)}>Cancel</button>
            <button type="submit" disabled={!!error}>{pending.confirmLabel}</button>
          </div>
        </form>
      </div>
    </div>
  );
}
