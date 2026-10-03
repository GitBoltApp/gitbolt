import { useEffect, useMemo, useRef, useState } from 'react';
import { create } from 'zustand';
import { useModalKeys } from '../app/modalKeys';
import { usePopoverPlace } from './arm/anchor';
import { currentOrigin, OVERLAY_ATTR, originRect, type Origin } from './arm/origin';
import { arm, confirmable, disarm } from './arm/store';
import './choice.css';

/** One answer of a choice. `danger`: it arms in place before it goes ("Click again to force
 * push"); `arm` is that label (default: "Click again to <label>"). */
export interface Choice { id: string; label: string; primary?: boolean; danger?: boolean; arm?: string; /** Not a way forward (Details): a neutral button. */ quiet?: boolean; /** Greyed: the body says why (a refused rebase, 2D T18). */ disabled?: boolean }
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

interface Pending extends ChoiceRequest { resolve(r: ChoiceResult): void; origin: Origin | null; seq: number }
const useChoiceStore = create<{ pending: Pending | null }>(() => ({ pending: null }));
let seq = 0;

/**
 * A real choice, more than one way forward (spec §ui confirms, board G: push rejected, Rebase /
 * Merge, Save / Discard edits): a popover anchored where the action started (`origin`, default
 * the current one). The safe choice comes first and takes the focus (the `primary` one, else the
 * first enabled one), so Enter goes; a `danger` choice still arms in place. Cancel, Esc, a press
 * outside or a newer request resolve `{ choice: null }`. Mount `<ChoiceDialog />` once.
 */
export function askChoice(req: ChoiceRequest, origin: Origin | null = currentOrigin()): Promise<ChoiceResult> {
  useChoiceStore.getState().pending?.resolve({ choice: null, checked: false });
  disarm();
  return new Promise((resolve) => useChoiceStore.setState({ pending: { ...req, origin, resolve, seq: ++seq } }));
}

export function ChoiceDialog() {
  const pending = useChoiceStore((s) => s.pending);
  if (!pending) return null;
  return <ChoiceForm pending={pending} key={pending.seq} />;
}

const lower = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);

function ChoiceForm({ pending }: { pending: Pending }) {
  const [checked, setChecked] = useState(pending.checkbox?.checked ?? false);
  const done = (choice: string | null) => {
    if (useChoiceStore.getState().pending !== pending) return;
    useChoiceStore.setState({ pending: null });
    pending.resolve({ choice, checked: choice === null ? false : checked });
  };
  const focusId = (pending.choices.find((c) => c.primary && !c.disabled) ?? pending.choices.find((c) => !c.disabled && !c.danger) ?? pending.choices.find((c) => !c.disabled))?.id;
  const ref = useModalKeys<HTMLDivElement>(true, () => done(null));
  const anchor = useMemo(() => originRect(pending.origin), [pending.origin]);
  const pos = usePopoverPlace(ref, anchor);
  const doneRef = useRef(done);
  doneRef.current = done;
  // A press outside it cancels; the armed overlay of one of its choices is part of it.
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      const t = e.target instanceof Element ? e.target : null;
      if (t && (ref.current?.contains(t) || t.closest(`[${OVERLAY_ATTR}]`))) return;
      doneRef.current(null);
    };
    window.addEventListener('pointerdown', onDown, true);
    return () => window.removeEventListener('pointerdown', onDown, true);
  }, [ref]);
  // The primary choice takes the focus, after the focus trap's own (which, re-run, would put it
  // on the first button: React's dev double effects).
  useEffect(() => { ref.current?.querySelector<HTMLElement>('[data-autofocus]')?.focus({ preventScroll: true }); }, [ref]);
  // The settle guard (as an armed control's): a choice is a fresh gesture made after the popover
  // opened, so a held Enter or a repeat click that started the action never picks one.
  const [openedAt] = useState(() => ({ at: performance.now() }));
  const pick = async (c: Choice, e: MouseEvent) => {
    if (!confirmable(e, openedAt)) return;
    if (c.danger && !(await arm({ arm: c.arm ?? `Click again to ${lower(c.label)}`, tone: 'danger', title: c.label, body: pending.body, confirmLabel: c.label }))) return;
    done(c.id);
  };
  return (
    <div
      ref={ref}
      data-arm-popover=""
      className="arm-popover choices"
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="choice-title"
      aria-describedby="choice-body"
      style={pos ?? { opacity: 0, left: 0, top: 0 }}
    >
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
        <button type="button" className="choice-cancel" autoFocus={focusId === undefined} data-autofocus={focusId === undefined || undefined} onClick={() => done(null)}>Cancel</button>
        {pending.choices.map((c) => (
          <button key={c.id} type="button" disabled={c.disabled} autoFocus={c.id === focusId} data-autofocus={c.id === focusId || undefined} className={c.danger ? 'danger' : c.primary ? 'primary positive' : c.quiet ? 'choice-quiet' : 'positive'} onClick={(e) => void pick(c, e.nativeEvent)}>{c.label}</button>
        ))}
      </div>
    </div>
  );
}
