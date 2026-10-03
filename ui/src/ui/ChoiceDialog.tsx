import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { create } from 'zustand';
import { useModalKeys } from '../app/modalKeys';
import { usePopoverPlace } from './arm/anchor';
import { currentOrigin, OVERLAY_ATTR, originRect, type Origin } from './arm/origin';
import { arm, confirmable, disarm } from './arm/store';
import './choice.css';

/** One answer of a choice. `danger`: it arms in place before it goes ("Click again to force
 * push"); `arm` is that label (default: "Click again to <label>"). */
export interface Choice { id: string; label: string; primary?: boolean; danger?: boolean; arm?: string; /** Not a way forward (Details): a text link at the end of the body. */ quiet?: boolean; /** Greyed: the body says why (a refused rebase, 2D T18). */ disabled?: boolean }
export interface ChoiceRequest {
  /** The situation, said once. */
  title: string;
  /** Only what the title doesn't say. */
  body?: string;
  /** A second paragraph (a conflict preview), shown only when set. */
  note?: string;
  choices: Choice[];
}
export interface ChoiceResult { choice: string | null }

interface Pending extends ChoiceRequest { resolve(r: ChoiceResult): void; origin: Origin | null; seq: number }
const useChoiceStore = create<{ pending: Pending | null }>(() => ({ pending: null }));
let seq = 0;

/**
 * A real choice, more than one way forward (spec §ui confirms, board G: push rejected, Rebase /
 * Merge, Save / Discard edits): a popover anchored where the action started (`origin`, default
 * the current one). `choices` go safe first: the safe one takes the focus (the `primary` one, else
 * the first enabled one), so Enter goes; a `danger` choice still arms in place. The buttons sit in
 * one right-aligned row at their natural widths, as the app's dialogs: a quiet Cancel left-most,
 * then the choices from the riskiest to the safe one, right-most; a `quiet` choice (Details) is a
 * link at the end of the body. Cancel, Esc, a press outside or a newer request resolve
 * `{ choice: null }`. Mount `<ChoiceDialog />` once.
 */
export function askChoice(req: ChoiceRequest, origin: Origin | null = currentOrigin()): Promise<ChoiceResult> {
  useChoiceStore.getState().pending?.resolve({ choice: null });
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
  const done = (choice: string | null) => {
    if (useChoiceStore.getState().pending !== pending) return;
    useChoiceStore.setState({ pending: null });
    pending.resolve({ choice });
  };
  const buttons = pending.choices.filter((c) => !c.quiet);
  const links = pending.choices.filter((c) => c.quiet);
  // The safe choice; none (only risky ones): Cancel.
  const focusId = (buttons.find((c) => c.primary && !c.disabled) ?? buttons.find((c) => !c.disabled && !c.danger))?.id;
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
    if (c.danger && !(await arm({ arm: c.arm ?? `Click again to ${lower(c.label)}`, tone: 'danger', title: c.label, body: pending.body ?? '', confirmLabel: c.label }))) return;
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
      aria-describedby={pending.body || links.length ? 'choice-body' : undefined}
      style={pos ?? { opacity: 0, left: 0, top: 0 }}
    >
      <h2 id="choice-title">{pending.title}</h2>
      {(pending.body || links.length > 0) && (
        <p id="choice-body">
          {pending.body}
          {links.map((c) => (
            <Fragment key={c.id}>
              {' '}
              <button type="button" className="choice-link" disabled={c.disabled} onClick={(e) => void pick(c, e.nativeEvent)}>{c.label}</button>
            </Fragment>
          ))}
        </p>
      )}
      {pending.note && <p className="modal-note">{pending.note}</p>}
      {/* A risky choice arms in place over the whole row (data-arm-cover): nothing moves. */}
      <div className="modal-actions choice-actions" data-arm-cover="">
        <button type="button" className="choice-cancel" autoFocus={focusId === undefined} data-autofocus={focusId === undefined || undefined} onClick={() => done(null)}>Cancel</button>
        {[...buttons].reverse().map((c) => (
          <button key={c.id} type="button" disabled={c.disabled} autoFocus={c.id === focusId} data-autofocus={c.id === focusId || undefined} className={c.danger ? 'danger' : c.primary ? 'primary positive' : 'positive'} onClick={(e) => void pick(c, e.nativeEvent)}>{c.label}</button>
        ))}
      </div>
    </div>
  );
}
