import { useEffect, useMemo, useRef } from 'react';
import { useModalKeys } from '../app/modalKeys';
import { usePopoverPlace } from './arm/anchor';
import { currentOrigin, originRect, type Origin } from './arm/origin';
import { arm, confirmable, insideArmed, useArm, type Armed, type ArmTone } from './arm/store';
import { askChoice } from './ChoiceDialog';
import './choice.css';

/**
 * A confirmation for a destructive or hard-to-undo action (spec §ui confirms). The control the
 * action started from arms in place and says what a second click does (`arm`: "Click again to
 * delete origin/x"); `caption`, a reason shown under it. With no control to arm (a keyboard
 * shortcut, a control gone since), it's a popover anchored there with `title`, `body` and
 * `confirmLabel`.
 */
export interface ConfirmRequest {
  title: string;
  body: string;
  confirmLabel: string;
  /** The armed control's label: what a second click does, with counts where known. */
  arm: string;
  caption?: string;
  /** Reads as dangerous (red); else positive (green), unless `tone` says otherwise. */
  danger?: boolean;
  tone?: ArmTone;
}

export interface Choice { id: string; label: string; danger?: boolean; /** The armed label of a `danger` choice. */ arm?: string }
export interface ChoiceRequest { title: string; body: string; choices: Choice[] }

/**
 * Asks, and resolves `true` only on the second click (or the popover's confirm). A click
 * elsewhere, Esc, the control going away or a newer question resolve `false`. `origin`: where
 * the action started, captured before an `await` (default: the current one). Mount
 * `<ConfirmDialog />` and `<ArmLayer />` once (AppShell).
 */
export function confirmAction(req: ConfirmRequest, origin: Origin | null = currentOrigin()): Promise<boolean> {
  const tone = req.tone ?? (req.danger ? 'danger' : 'positive');
  return arm({ arm: req.arm, tone, caption: req.caption, title: req.title, body: req.body, confirmLabel: req.confirmLabel }, origin);
}

/** A question with several answers besides Cancel (spec #2 §7.5: [Save] [Discard edits]
 * [Cancel]; [Reload] [Overwrite]): the anchored choice popover (`askChoice`). Resolves the
 * picked choice's id, or `null` for Cancel, Esc, a click outside or a newer question. */
export function chooseAction(req: ChoiceRequest, origin: Origin | null = currentOrigin()): Promise<string | null> {
  return askChoice({ title: req.title, body: req.body, choices: req.choices.map((c, i) => ({ ...c, primary: i === 0 && !c.danger })) }, origin).then((r) => r.choice);
}

/** The popover for a confirmation with no control to arm (board H). */
export function ConfirmDialog() {
  const armed = useArm((s) => s.armed);
  if (!armed || armed.mode !== 'popover') return null;
  return <ConfirmPopover a={armed} key={armed.id} />;
}

function ConfirmPopover({ a }: { a: Armed }) {
  const cancel = () => a.resolve(false);
  const ref = useModalKeys<HTMLDivElement>(true, cancel);
  const anchor = useMemo(() => originRect(a.origin), [a.origin]);
  const pos = usePopoverPlace(ref, anchor);
  const latest = useRef(a);
  latest.current = a;
  // A press outside it cancels (the press carries on to whatever it hit).
  useEffect(() => {
    const onDown = (e: PointerEvent) => { if (!insideArmed(latest.current, e.target)) latest.current.resolve(false); };
    window.addEventListener('pointerdown', onDown, true);
    return () => window.removeEventListener('pointerdown', onDown, true);
  }, []);
  // Board H (started from the keyboard): the primary button takes the focus, so Enter goes. A
  // popover that opens after a click's write (the control gone) focuses Cancel: a key pressed
  // meanwhile mustn't run the destructive answer. After the focus trap's own focus (which,
  // re-run, would put it on the first button: React's dev double effects).
  useEffect(() => { ref.current?.querySelector<HTMLElement>('[data-autofocus]')?.focus({ preventScroll: true }); }, [ref]);
  const tone = a.req.tone;
  return (
    <div
      ref={ref}
      data-arm-popover=""
      className={`arm-popover tone-${tone}`}
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="confirm-title"
      aria-describedby="confirm-body"
      style={pos ?? { opacity: 0, left: 0, top: 0 }}
    >
      <h2 id="confirm-title">{a.req.title}</h2>
      <p id="confirm-body">{a.req.body}</p>
      <div className="modal-actions">
        {/* Only a fresh press after the popover opened answers it (the settle guard). */}
        <button type="button" autoFocus={a.hints} data-autofocus={a.hints || undefined} className={tone === 'danger' ? 'danger' : tone === 'warn' ? 'warn' : 'positive'} onClick={(e) => { if (confirmable(e.nativeEvent, a)) a.resolve(true); }}>{a.req.confirmLabel}</button>
        <button type="button" autoFocus={!a.hints} data-autofocus={!a.hints || undefined} onClick={cancel}>Cancel</button>
        {a.hints && <span className="arm-hints" aria-hidden><kbd>⏎</kbd>go<kbd>Esc</kbd>cancel</span>}
      </div>
    </div>
  );
}
