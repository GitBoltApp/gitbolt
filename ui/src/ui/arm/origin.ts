/**
 * Where an action came from (the confirm model, spec §ui confirms): the control the user clicked
 * (or pressed Enter/Space on), a context menu row, or the element that had focus when a keyboard
 * shortcut ran. A confirmation arms that control in place; with no control to arm (a shortcut, a
 * control that has gone since), it's a popover anchored where the action started.
 *
 * The listeners are on `window` in the capture phase, so they see the event before any handler
 * (the key router's, React's) acts on it: import this module before anything registers keys
 * (main.tsx does).
 */

/** A context menu row's hooks: the menu closes once the action no longer needs its row. */
export interface MenuHooks { close(): void }

export interface Origin {
  el: HTMLElement;
  /** Its box when the action started: where a popover goes once the control is gone (null: a
   * key's origin, measured only when asked, so typing never forces a layout). */
  rect: DOMRect | null;
  /** The action was started from the keyboard. */
  via: 'pointer' | 'key';
  /** `el` is a control (a button, a menu row) that can arm itself. */
  control: boolean;
  /** Set for a context menu row. */
  menu?: MenuHooks;
  /** `holdOrigin` calls still out: a menu row's menu stays open meanwhile. */
  holds: number;
}

const CONTROL = 'button, [role="button"], [role="menuitem"], a[href], [data-arm-origin]';
/** The armed overlay: a click on it is the confirm, not a new origin. */
export const OVERLAY_ATTR = 'data-arm-overlay';

let last: Origin | null = null;
/** The second activation of an armed control (see `setArmedIntercept`). */
let intercept: ((target: Element, e: MouseEvent) => boolean) | null = null;

const make = (el: HTMLElement, via: Origin['via'], control: boolean, menu?: MenuHooks, measure = true): Origin =>
  ({ el, rect: measure ? el.getBoundingClientRect() : null, via, control, menu, holds: 0 });

/** Where the origin is now: its element's box while it's shown, else the box it had. */
export function originRect(o: Origin | null): DOMRect | null {
  if (!o) return null;
  if (o.el.isConnected && o.el.getClientRects().length > 0) return o.el.getBoundingClientRect();
  return o.rect;
}

/** The origin of the action running now (or the most recent one): capture it at the start of an
 * action that may ask after an `await`. */
export const currentOrigin = (): Origin | null => last;

/** For tests and the menu: makes `o` the current origin. */
export function setOrigin(o: Origin | null): void { last = o; }

/** The armed store's hook: a click inside the armed control is its second click. */
export function setArmedIntercept(fn: ((target: Element, e: MouseEvent) => boolean) | null): void { intercept = fn; }

function onClick(e: MouseEvent) {
  const t = e.target instanceof Element ? e.target : null;
  if (!t) return;
  // A click inside the armed control (Enter on a focused button, a part of it the overlay doesn't
  // cover): its second click if it's a fresh one (`confirmable`), else swallowed; nothing else
  // sees it.
  if (intercept?.(t, e)) {
    e.preventDefault();
    e.stopImmediatePropagation();
    return;
  }
  if (t.closest(`[${OVERLAY_ATTR}]`)) return; // the confirm click keeps the armed origin
  const ctl = t.closest<HTMLElement>(CONTROL);
  // The context menu sets its own origins (rows, with their hooks).
  if (ctl?.closest('.ctx-menu')) return;
  const el = ctl ?? (t instanceof HTMLElement ? t : null);
  if (el) last = make(el, e.detail === 0 ? 'key' : 'pointer', !!ctl);
}

function onKey(e: KeyboardEvent) {
  if (e.key === 'Shift' || e.key === 'Control' || e.key === 'Alt' || e.key === 'Meta') return;
  const t = e.target instanceof Element ? e.target : null;
  // Enter/Space on a control clicks it: the click is the origin.
  if ((e.key === 'Enter' || e.key === ' ') && t?.closest(CONTROL)) return;
  if (t?.closest('.ctx-menu')) return;
  const focused = document.activeElement instanceof HTMLElement ? document.activeElement : document.body;
  last = make(focused, 'key', false, undefined, false);
}

let installed = false;
export function installOriginListeners(): void {
  if (installed || typeof window === 'undefined') return;
  installed = true;
  window.addEventListener('click', onClick, true);
  window.addEventListener('keydown', onKey, true);
}
installOriginListeners();

/** A context menu row runs `run` with itself as the origin. The menu closes after `run`'s
 * synchronous part unless the action armed the row or holds it (`holdOrigin`). */
export function runFromMenu(el: HTMLElement, via: Origin['via'], close: () => void, run: () => void, isArmed: (o: Origin) => boolean): void {
  const o = make(el, via, true, { close });
  last = o;
  try {
    run();
  } finally {
    if (o.holds === 0 && !isArmed(o)) close();
  }
}

/**
 * Keeps the current origin's menu open while an action finds out whether it must ask (an
 * integrate's preview): call it before the first `await`; the release closes the menu unless the
 * action armed its row meanwhile. A no-op outside a menu.
 */
export function holdOrigin(isArmed: (o: Origin) => boolean): () => void {
  const o = last;
  if (!o?.menu) return () => {};
  o.holds++;
  let done = false;
  return () => {
    if (done) return;
    done = true;
    o.holds--;
    if (o.holds === 0 && !isArmed(o)) o.menu!.close();
  };
}
