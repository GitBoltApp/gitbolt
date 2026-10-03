import { create } from 'zustand';
import { currentOrigin, holdOrigin as holdOriginOf, OVERLAY_ATTR, setArmedIntercept, type Origin } from './origin';

/** How an armed control reads: destructive red, positive green, a warning amber. */
export type ArmTone = 'danger' | 'positive' | 'warn';

/**
 * One confirmation (spec §ui confirms). `arm` is the armed control's label, what a second click
 * does ("Click again to discard 5 files"); `caption`, a reason shown under it. `title`, `body`
 * and `confirmLabel` are the popover's, used when there's no control to arm (a keyboard
 * shortcut, a control gone since the action started).
 */
export interface ArmRequest {
  arm: string;
  tone: ArmTone;
  caption?: string;
  title: string;
  body: string;
  confirmLabel: string;
}

/**
 * - `inplace`: the control itself becomes the confirm (an overlay over it, `ArmLayer`).
 * - `inline`: a context menu row, drawn armed by the menu.
 * - `popover`: anchored where the action started (`ConfirmDialog`); `hints` when it was started
 *   from the keyboard (Enter goes, Esc cancels).
 */
export type ArmMode = 'inplace' | 'inline' | 'popover';

export interface Armed {
  id: number;
  req: ArmRequest;
  origin: Origin | null;
  mode: ArmMode;
  hints: boolean;
  /** `performance.now()` when it armed: a confirm must be a fresh gesture after it. */
  at: number;
  resolve(ok: boolean): void;
}

export const useArm = create<{ armed: Armed | null }>(() => ({ armed: null }));

let seq = 0;
const shown = (el: HTMLElement) => el.isConnected && el.getClientRects().length > 0;

function modeOf(o: Origin | null): ArmMode {
  if (o?.menu && o.el.isConnected) return 'inline';
  if (o?.control && shown(o.el)) return 'inplace';
  return 'popover';
}

/**
 * Arms `origin` (by default the control the current action started from) and resolves `true` on
 * its second click, `false` once it's disarmed: a click anywhere else, Esc, focus or the window
 * going elsewhere, its control going away, or another control arming. There is no timer. Only
 * one control is armed app-wide.
 */
export function arm(req: ArmRequest, origin: Origin | null = currentOrigin()): Promise<boolean> {
  useArm.getState().armed?.resolve(false);
  const mode = modeOf(origin);
  const hints = mode === 'popover' && (!origin || (origin.via === 'key' && !origin.control));
  return new Promise((resolve) => {
    const id = ++seq;
    const done = (ok: boolean) => {
      if (useArm.getState().armed?.id !== id) return;
      useArm.setState({ armed: null });
      // A menu row confirmed: its menu closes now (the action carries on without it).
      if (ok && origin?.menu) origin.menu.close();
      resolve(ok);
    };
    useArm.setState({ armed: { id, req, origin, mode, hints, at: performance.now(), resolve: done } });
  });
}

/** The armed control's second click. */
export function confirmArmed(): void { useArm.getState().armed?.resolve(true); }

/** Disarms whatever is armed (its action does nothing). */
export function disarm(): void { useArm.getState().armed?.resolve(false); }

/** `o` is the armed origin. */
export const isArmedOrigin = (o: Origin): boolean => useArm.getState().armed?.origin === o;

/** `el` is the armed control. */
export const isArmedEl = (el: Element | null): boolean => !!el && useArm.getState().armed?.origin?.el === el;

/** `holdOrigin` for the armed store: the release closes the menu unless the row armed. */
export const holdOrigin = (): (() => void) => holdOriginOf(isArmedOrigin);

/**
 * The settle guard (fix round 1): a confirm must be a new gesture, started after the control
 * armed and at least this long after it, so the second click of a double-click, a held Enter's
 * repeats, or a repeat click that lands as a late question arms never confirms. It's a minimum,
 * not a timer: the armed state never expires on its own.
 */
export const SETTLE_MS = 350;
let lastDown = -Infinity;
/** An Enter/Space is being held (a repeat came, no keyup yet). */
let repeating = false;

/** Whether click `e` may confirm `a` (an armed control, or a popover since it opened: `at`):
 * past the settle, and a single click whose press started after it, or a click with no pointer
 * (`detail` 0: Enter/Space, or assistive technology's activation) while no key is held. A held
 * key's repeats are cancelled at keydown, so they never produce one. */
export function confirmable(e: { detail: number }, a: { at: number } | null = useArm.getState().armed): boolean {
  if (!a || performance.now() - a.at < SETTLE_MS) return false;
  if (e.detail === 0) return !repeating;
  return e.detail === 1 && lastDown > a.at;
}

/** Whether key `e` (Enter/Space, taken by the menu itself) may confirm `a`. */
export const confirmableKey = (e: KeyboardEvent, a: Armed | null = useArm.getState().armed): boolean =>
  !!a && !e.repeat && performance.now() - a.at >= SETTLE_MS;

if (typeof window !== 'undefined') {
  window.addEventListener('pointerdown', () => { lastDown = performance.now(); }, true);
  window.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    repeating = e.repeat;
    if (!e.repeat) return;
    // A held key's repeats never click the armed control, nor any button of a popover (a
    // confirm or a choice), armed or not.
    const a = useArm.getState().armed;
    const t = e.target instanceof Element ? e.target : null;
    if (t && (a?.origin?.el.contains(t) || t.closest('[data-arm-popover]'))) e.preventDefault();
  }, true);
  window.addEventListener('keyup', (e) => { if (e.key === 'Enter' || e.key === ' ') repeating = false; }, true);
}

// A click inside the armed control (Enter/Space on it while focused): its second click when it's
// a fresh one, else swallowed.
setArmedIntercept((t, e) => {
  const a = useArm.getState().armed;
  if (!a || a.mode !== 'inplace' || !a.origin) return false;
  if (!a.origin.el.contains(t)) return false;
  if (confirmable(e, a)) confirmArmed();
  return true;
});

/** The last press that disarmed (a press elsewhere): a menu swallows its click, so a click on
 * another row only disarms (it doesn't also run that row). */
let disarmPress: EventTarget | null = null;
export function consumeDisarmClick(target: EventTarget | null): boolean {
  if (!disarmPress || !(target instanceof Node) || !(disarmPress instanceof Node)) return false;
  const hit = target === disarmPress || target.contains(disarmPress) || disarmPress.contains(target);
  disarmPress = null;
  return hit;
}

/** Whether a press at `t` is inside the armed control (or its overlay, or its popover). */
export function insideArmed(a: Armed, t: EventTarget | null): boolean {
  if (!(t instanceof Element)) return false;
  if (t.closest(`[${OVERLAY_ATTR}]`)) return true;
  if (a.mode === 'popover') return !!t.closest('[data-arm-popover]');
  return !!a.origin?.el.contains(t);
}

/** Press-outside: disarms (the press itself carries on to whatever it hit). */
export function onArmPress(e: PointerEvent): void {
  const a = useArm.getState().armed;
  if (!a || insideArmed(a, e.target)) return;
  const press = e.target;
  disarmPress = press;
  // The press's click comes at the end of the same gesture; a later click isn't this press's.
  const clear = () => { setTimeout(() => { if (disarmPress === press) disarmPress = null; }, 0); };
  window.addEventListener('pointerup', clear, { once: true, capture: true });
  window.addEventListener('pointercancel', clear, { once: true, capture: true });
  disarm();
}

/** Esc presses that disarmed: a dialog in the same key layer leaves them alone (it stays open). */
export const escHandled = new WeakSet<KeyboardEvent>();
/** Whether Esc `e` is the armed control's (it disarms; nothing else closes on it). */
export const escapeDisarms = (e: KeyboardEvent): boolean =>
  escHandled.has(e) || (e.key === 'Escape' && useArm.getState().armed?.mode === 'inplace');
