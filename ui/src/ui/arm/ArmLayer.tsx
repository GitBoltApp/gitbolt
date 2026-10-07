import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useAppState } from '../../app/state';
import { registerKeys } from '../keyRouter';
import { armBounds, armPlacement } from './grow';
import { OVERLAY_ATTR } from './origin';
import { confirmable, confirmArmed, disarm, escHandled, onArmPress, useArm, type Armed } from './store';
import './arm.css';

/** The armed label, for the armed control's `aria-describedby`. */
const ARM_DESC_ID = 'gb-armed-desc';

/** A window blur disarms only once the window stays unfocused this long: under GNOME every press
 * in the window bounces its focus (the context menu's K24, `BLUR_SETTLE_MS`). */
const BLUR_SETTLE_MS = 150;

interface Box { left: number; top: number; width: number; height: number; right: number; bottom: number }
const boxOf = (r: DOMRect): Box => ({ left: r.left, top: r.top, width: r.width, height: r.height, right: r.right, bottom: r.bottom });
const same = (a: Box | null, b: Box) => !!a && a.left === b.left && a.top === b.top && a.width === b.width && a.height === b.height;

/**
 * Where the overlay goes, from the armed control:
 * - its own box, or the box of its closest `[data-arm-cover]` (a row's actions, a button pair):
 *   the overlay covers the control's neighbours instead of moving them;
 * - a label longer than that grows the overlay over the adjacent content, toward the side of its
 *   container (the nearest panel or scroll box, `armBounds`) with room for it: `data-arm-grow` on
 *   the control or an ancestor says which side first. It never crosses the container's edge.
 *   `needed`: the label's natural width (0 until measured).
 */
function geometry(el: HTMLElement, needed: number): { box: Box; grow: 'left' | 'right'; maxWidth: number; cover: boolean } {
  const coverEl = el.closest<HTMLElement>('[data-arm-cover]');
  const base = (coverEl ?? el).getBoundingClientRect();
  const growAttr = el.closest('[data-arm-grow]')?.getAttribute('data-arm-grow');
  const preferred = growAttr === 'left' || growAttr === 'right' ? growAttr : null;
  const { grow, maxWidth } = armPlacement(base, armBounds(coverEl ?? el), needed, preferred);
  return { box: boxOf(base), grow, maxWidth, cover: !!coverEl };
}

/** The armed control's icon, when it's an icon button: the pill keeps it (board B). */
function iconOf(el: HTMLElement): string | null {
  if (el.textContent?.trim()) return null;
  return el.querySelector('svg')?.outerHTML ?? null;
}

function Overlay({ a }: { a: Armed & { origin: NonNullable<Armed['origin']> } }) {
  const el = a.origin.el;
  const overlay = useRef<HTMLButtonElement>(null);
  // The label's natural width (the overlay's content, past its max-width), once drawn.
  const needed = useRef(0);
  const [geo, setGeo] = useState(() => geometry(el, 0));
  useLayoutEffect(() => {
    needed.current = overlay.current?.scrollWidth ?? 0;
    setGeo(geometry(el, needed.current));
  }, [el, a.req.arm]);
  // Follows the control (a scroll, a resize); disarms once it's gone or hidden: the thing it
  // would act on changed. (Not when it's disabled: a toolbar button is, while its action asks.)
  useEffect(() => {
    let frame = 0;
    const raf = window.requestAnimationFrame ?? ((f: FrameRequestCallback) => window.setTimeout(() => f(performance.now()), 16));
    const caf = window.cancelAnimationFrame ?? window.clearTimeout;
    const tick = () => {
      if (!el.isConnected || el.getClientRects().length === 0) {
        disarm();
        return;
      }
      const g = geometry(el, needed.current);
      setGeo((old) => (same(old.box, g.box) && old.grow === g.grow && old.maxWidth === g.maxWidth ? old : g));
      frame = raf(tick);
    };
    frame = raf(tick);
    return () => caf(frame);
  }, [el]);
  // The control and what the overlay covers dim underneath (`data-arm-dim`). The control is
  // described by its armed label, for a screen reader on it (the overlay is visual only).
  useLayoutEffect(() => {
    el.setAttribute('data-armed', a.req.tone);
    const described = el.getAttribute('aria-describedby');
    el.setAttribute('aria-describedby', described ? `${described} ${ARM_DESC_ID}` : ARM_DESC_ID);
    const dim = el.closest<HTMLElement>('[data-arm-dim]');
    dim?.classList.add('arm-dimmed');
    return () => {
      el.removeAttribute('data-armed');
      if (described) el.setAttribute('aria-describedby', described);
      else el.removeAttribute('aria-describedby');
      dim?.classList.remove('arm-dimmed');
    };
  }, [el, a.req.tone]);
  const { box, grow, maxWidth, cover } = geo;
  const icon = iconOf(el);
  const side = grow === 'right' ? { left: box.left } : { right: window.innerWidth - box.right };
  return (
    <>
      {/* Visual only: the control keeps the focus and its name; Enter on it is the second click. */}
      <button
        ref={overlay}
        type="button"
        tabIndex={-1}
        aria-hidden
        {...{ [OVERLAY_ATTR]: '' }}
        className={`arm-overlay tone-${a.req.tone}${cover ? ' arm-cover' : ''}`}
        style={{ ...side, top: box.top, height: box.height, minWidth: box.width, maxWidth }}
        // The control keeps the focus (Enter on it is the second click too).
        onMouseDown={(e) => e.preventDefault()}
        // Only a fresh single click after the settle confirms (`confirmable`): not a double
        // click's second, nor a repeat click that lands as a late question arms.
        onClick={(e) => { e.stopPropagation(); if (confirmable(e.nativeEvent)) confirmArmed(); }}
      >
        {icon && <span className="arm-icon" aria-hidden dangerouslySetInnerHTML={{ __html: icon }} />}
        <span className="arm-label">{a.req.arm}</span>
      </button>
      {a.req.caption && (
        <div {...{ [OVERLAY_ATTR]: '' }} className={`arm-caption tone-${a.req.tone}`} style={{ ...side, top: box.bottom + 6 }}>
          {a.req.caption}
        </div>
      )}
    </>
  );
}

/**
 * The armed control's overlay (mode `inplace`) and the disarm rules for every mode (spec §ui
 * confirms): a press anywhere else, Esc, focus moving elsewhere, the window losing focus, the
 * tab changing. There is no timer. Also the live region that announces "Click again to …".
 * Mount once (AppShell).
 */
export function ArmLayer() {
  const armed = useArm((s) => s.armed);
  const id = armed?.id ?? null;
  const mode = armed?.mode ?? null;
  useEffect(() => {
    if (id === null) return;
    // UX R1 C.2: where focus was when it armed. Under GNOME every press makes the window lose
    // focus and get it back a few ms later (windowBlur.ts), and the browser gives it back to that
    // element: a focusin there before the confirm press's click. That's focus returning, not
    // moving elsewhere; disarming on it ate the confirm (the click then re-armed the control).
    const had = document.activeElement;
    const onFocusIn = (e: FocusEvent) => {
      const a = useArm.getState().armed;
      if (a?.mode !== 'inplace' || !(e.target instanceof Element)) return;
      if (a.origin?.el.contains(e.target) || e.target.closest(`[${OVERLAY_ATTR}]`)) return;
      if (e.target === had) return;
      disarm();
    };
    let blurTimer: ReturnType<typeof setTimeout> | undefined;
    const onBlur = () => { clearTimeout(blurTimer); blurTimer = setTimeout(disarm, BLUR_SETTLE_MS); };
    const onFocus = () => clearTimeout(blurTimer);
    const offKeys = registerKeys('menu', (e) => {
      if (e.key !== 'Escape' || useArm.getState().armed?.mode !== 'inplace') return;
      escHandled.add(e);
      disarm();
      e.preventDefault();
      return 'handled';
    });
    const tab = useAppState.getState().profile.activeTab;
    const offTab = useAppState.subscribe((s) => { if (s.profile.activeTab !== tab) disarm(); });
    window.addEventListener('pointerdown', onArmPress, true);
    document.addEventListener('focusin', onFocusIn, true);
    window.addEventListener('blur', onBlur);
    window.addEventListener('focus', onFocus);
    return () => {
      offKeys();
      offTab();
      clearTimeout(blurTimer);
      window.removeEventListener('pointerdown', onArmPress, true);
      document.removeEventListener('focusin', onFocusIn, true);
      window.removeEventListener('blur', onBlur);
      window.removeEventListener('focus', onFocus);
    };
  }, [id]);
  return (
    <>
      {armed && mode === 'inplace' && armed.origin && <Overlay key={armed.id} a={armed as Armed & { origin: NonNullable<Armed['origin']> }} />}
      <div className="arm-live" aria-live="polite" data-testid="arm-live">{armed && mode !== 'popover' ? armed.req.arm : ''}</div>
      <span id={ARM_DESC_ID} hidden>{armed && mode === 'inplace' ? armed.req.arm : ''}</span>
    </>
  );
}
