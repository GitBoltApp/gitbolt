import { cloneElement, useCallback, useEffect, useLayoutEffect, useRef, useState, type MouseEvent, type ReactElement, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { registerKeys } from './keyRouter';
import './tooltip.css';

/** The plain Esc that dismisses a shown tooltip (`HoverTooltip`, `TooltipHost`). */
export const isDismissKey = (e: KeyboardEvent) => e.key === 'Escape' && !e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey && !e.isComposing;

/**
 * The hover tooltip that wraps a trigger (plan 1C Task 10's tooltip primitive, pulled into 1B:
 * this is its `<Tooltip text delay?>`). Anything that needs an instant (or deliberately delayed)
 * tooltip uses this instead of the native `title`, whose OS delay breaks the app-wide "tooltips
 * show immediately" rule. Controls built from data (the context menu) use the imperative
 * `showTooltip` and the one `<TooltipHost />` instead (`tooltipStore.ts`), with the same look
 * and placement (`placeBelow`).
 *
 * - `delayMs` defaults to 0 (show immediately). The one deliberate exception is the graph's
 *   full commit-message tooltip (~500 ms, spec §8.4).
 * - `interactive`: the pointer may move from the trigger into the tooltip (e.g. to scroll a
 *   long message) without closing it. Otherwise the tooltip ignores the pointer entirely.
 * - `placement`: `'below'` (default) puts it under the trigger, flipped above if it doesn't
 *   fit. `'pointer'` puts it POINTER_GAP px right of the cursor (flipped to its left if it
 *   doesn't fit), at the cursor's height, and follows the pointer while shown. Never
 *   interactive: it's meant to sit next to the pointer without ever catching it (the graph's
 *   message tooltip, feedback F1). `'left-of'` puts it left of the element `leftOf` returns for
 *   the trigger (a panel), its right edge LEFT_OF_GAP px before that element's left edge, centred
 *   on the trigger's height: over the area beside the panel, so it never covers the rows above or
 *   below the hovered one (the file list, feedback J18). Without room there, it goes below.
 * - `content` may be a function, called once the delay has elapsed. It can return the content
 *   (e.g. from a cache) or a promise of it: if that takes over `loadingDelayMs` (~100 ms),
 *   `loadingContent` ("Loading…") shows meanwhile. A load that resolves after the pointer left
 *   or the page scrolled shows nothing; a failed load closes the tooltip.
 * - Hidden, and a pending (delayed or loading) tooltip cancelled, on leave, on any scroll
 *   outside the tooltip, and on window resize.
 * - Esc dismisses a shown tooltip (WCAG 1.4.13), and does nothing else: it's the key router's
 *   `tooltip` layer (`keyRouter.ts`), so the app's Esc (`useAppEscape`) never sees that press.
 *
 * Pointer-only: keyboard focus doesn't open it (see the call sites for how keyboard users get
 * the same information).
 */
export type TooltipContent = ReactNode | (() => ReactNode | Promise<ReactNode>);

export interface HoverTooltipOptions {
  content: TooltipContent;
  delayMs?: number;
  interactive?: boolean;
  className?: string;
  disabled?: boolean;
  loadingDelayMs?: number;
  loadingContent?: ReactNode;
  placement?: 'below' | 'pointer' | 'left-of';
  /** placement 'left-of': the element (e.g. the panel holding the trigger) to sit left of. */
  leftOf?: (trigger: HTMLElement) => Element | null;
}

type TriggerProps = { onMouseEnter(e: MouseEvent<HTMLElement>): void; onMouseLeave(e: MouseEvent<HTMLElement>): void; onMouseOver(e: MouseEvent<HTMLElement>): void; onMouseMove?(e: MouseEvent<HTMLElement>): void };

const GAP = 4;
const EDGE = 8;
/** Horizontal distance between the cursor's hotspot and a `placement: 'pointer'` tooltip: clears
 * the arrow cursor's ~12px-wide body, so the tooltip never sits under the pointer. */
export const POINTER_GAP = 12;
/** placement 'left-of': between the tooltip's right edge and the `leftOf` element's left edge. */
export const LEFT_OF_GAP = 6;
/** An interactive tooltip overlaps its trigger by 1px instead: any gap would be crossed over
 * whatever lies between (e.g. the next row), which counts as leaving and closes it. */
const gapFor = (interactive: boolean) => (interactive ? -1 : GAP);

const isThenable = (v: unknown): v is PromiseLike<ReactNode> => typeof (v as { then?: unknown } | null)?.then === 'function';

/** What the tooltip is placed against: the trigger's box, or (placement 'pointer') the cursor.
 * `leftOf`: placement 'left-of', the left edge of the element it sits left of. */
type Anchor = { left: number; top: number; bottom: number; leftOf?: number };
/** What's on screen: `node` is null for static content, which then renders live from props. */
type Shown = { anchor: Anchor; node: ReactNode | null };

type Size = { width: number; height: number };

/** Below `anchor` (flipped above when it doesn't fit), kept inside the window. Shared with
 * `TooltipHost`, so every tooltip in the app sits the same way. */
/** The tooltip's size at its natural width. A fixed box shrinks to fit the room between its
 * `left` and the window's right edge, so a tooltip first laid out near that edge wraps one word
 * per line; parking it at the origin first gives it the room its `max-width` allows, and the
 * placement then shifts it, never shrinks it (K52). */
export function measureNatural(el: HTMLElement): Size {
  el.style.left = '0px';
  el.style.top = '0px';
  const { width, height } = el.getBoundingClientRect();
  return { width, height };
}

export function placeBelow(anchor: Anchor, { width, height }: Size, gap = GAP) {
  const left = Math.max(EDGE, Math.min(anchor.left, window.innerWidth - EDGE - width));
  let top = anchor.bottom + gap;
  if (top + height > window.innerHeight - EDGE) top = Math.max(EDGE, anchor.top - gap - height);
  return { left, top };
}

/** Beside `anchor` on `side` (flipped to the other side when it doesn't fit), at its top, kept
 * inside the window: a menu row's tooltip, clear of the rows below it. */
export function placeBeside(anchor: { left: number; right: number; top: number }, { width, height }: Size, side: 'left' | 'right' = 'right', gap = GAP) {
  const right = anchor.right + gap;
  const left = anchor.left - gap - width;
  const fitsRight = right + width <= window.innerWidth - EDGE;
  const fitsLeft = left >= EDGE;
  const x = side === 'right' ? (fitsRight || !fitsLeft ? right : left) : (fitsLeft || !fitsRight ? left : right);
  return { left: Math.max(EDGE, Math.min(x, window.innerWidth - EDGE - width)), top: Math.max(EDGE, Math.min(anchor.top, window.innerHeight - EDGE - height)) };
}

/** POINTER_GAP right of the cursor, or left of it when that would leave the window; at the
 * cursor's height, moved up if needed to stay inside the window. */
function pointerPosition(x: number, y: number, { width, height }: Size) {
  let left = x + POINTER_GAP;
  if (left + width > window.innerWidth - EDGE) left = x - POINTER_GAP - width;
  const top = Math.min(y, window.innerHeight - EDGE - height);
  return { left: Math.max(EDGE, left), top: Math.max(EDGE, top) };
}

export function useHoverTooltip({ content, delayMs = 0, interactive: interactiveOpt = false, className, disabled = false, loadingDelayMs = 100, loadingContent = 'Loading…', placement = 'below', leftOf }: HoverTooltipOptions) {
  const atPointer = placement === 'pointer';
  const interactive = interactiveOpt && !atPointer;
  const [shown, setShown] = useState<Shown | null>(null);
  // Removes the scroll/resize listeners. They're live from mouseenter until hidden, including
  // while the delay or a load is pending: scrolling in that window must cancel it too, not only
  // hide a tooltip already on screen. Attached in the mouseenter handler itself (not an effect),
  // so there's no frame between the hover and the listener in which a scroll goes unseen.
  const disarm = useRef<(() => void) | null>(null);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  // Bumped on every hide/re-arm: a late timer or load from an older hover checks it and bails.
  const generation = useRef(0);
  const triggerEl = useRef<HTMLElement | null>(null);
  // The pointer is over the trigger (from enter until leave; a hide on press or scroll leaves it
  // set, so moving within the trigger doesn't bring the tooltip back).
  const inside = useRef(false);
  const tipEl = useRef<HTMLDivElement>(null);
  // The latest pointer position over the trigger (placement 'pointer').
  const pointer = useRef({ x: 0, y: 0 });
  // The tooltip's size, measured once per content change in the layout effect: a mouse move
  // re-places it from this, without a layout read per move.
  const tipSize = useRef<Size>({ width: 0, height: 0 });
  const contentRef = useRef(content);
  contentRef.current = content;
  const leftOfRef = useRef(leftOf);
  leftOfRef.current = leftOf;

  const clearTimers = () => {
    for (const t of timers.current) clearTimeout(t);
    timers.current = [];
  };

  const hide = useCallback(() => {
    generation.current++;
    clearTimers();
    disarm.current?.();
    disarm.current = null;
    setShown(null);
  }, []);

  const arm = () => {
    if (disarm.current) return;
    const onScroll = (e: Event) => {
      if (e.target instanceof Node && tipEl.current?.contains(e.target)) return;
      hide();
    };
    // A press on the trigger hides it, as a native tooltip does: the user is acting on it now (and
    // a click, then Esc, is one Esc for the app, not one for the tooltip first).
    const onPress = (e: Event) => {
      if (e.target instanceof Node && triggerEl.current?.contains(e.target)) hide();
    };
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', hide);
    document.addEventListener('mousedown', onPress, true);
    disarm.current = () => {
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', hide);
      document.removeEventListener('mousedown', onPress, true);
    };
  };

  const open = shown !== null;
  // Esc dismisses it: the key router's `tooltip` layer, after an open menu and before the editor
  // overlays and the app's Esc (which closes the file on the next press). Registered only while
  // shown: the app has many (closed) tooltips.
  useEffect(() => {
    if (!open) return;
    return registerKeys('tooltip', (e) => {
      if (!isDismissKey(e)) return;
      hide();
      e.preventDefault();
      return 'handled';
    });
  }, [open, hide]);

  useEffect(() => () => {
    generation.current++;
    clearTimers();
    disarm.current?.();
    disarm.current = null;
  }, []);

  // Below the trigger, flipped above if it doesn't fit (or next to the pointer), and kept inside
  // the window. Re-run when the content changes ("Loading…" -> the message), since the size
  // changes.
  useLayoutEffect(() => {
    const tip = tipEl.current;
    if (!shown || !tip) return;
    const size = measureNatural(tip);
    tipSize.current = size;
    // Content cut at the max height gets `data-clipped`, for a visible cue (e.g. a fade).
    tip.toggleAttribute('data-clipped', tip.scrollHeight > tip.clientHeight);
    let left: number, top: number;
    if (atPointer) {
      ({ left, top } = pointerPosition(pointer.current.x, pointer.current.y, size));
    } else {
      const { anchor } = shown;
      const beside = anchor.leftOf === undefined ? null : anchor.leftOf - LEFT_OF_GAP - size.width;
      if (beside !== null && beside >= EDGE) {
        left = beside;
        top = Math.max(EDGE, Math.min((anchor.top + anchor.bottom - size.height) / 2, window.innerHeight - EDGE - size.height));
      } else ({ left, top } = placeBelow(anchor, size, gapFor(interactive)));
    }
    tip.style.left = `${left}px`;
    tip.style.top = `${top}px`;
  }, [shown, interactive, atPointer]);

  const isInside = (el: HTMLElement | null, target: EventTarget | null) => !!el && target instanceof Node && el.contains(target);

  const reveal = (gen: number) => {
    const show = (node: ReactNode | null) => {
      if (gen !== generation.current || !triggerEl.current) return;
      const { x, y } = pointer.current;
      const trigger = triggerEl.current;
      let anchor: Anchor;
      if (atPointer) anchor = { left: x + POINTER_GAP, top: y, bottom: y };
      else {
        const r = trigger.getBoundingClientRect();
        const beside = placement === 'left-of' ? leftOfRef.current?.(trigger) : null;
        anchor = { left: r.left, top: r.top, bottom: r.bottom, ...(beside && { leftOf: beside.getBoundingClientRect().left }) };
      }
      setShown({ anchor, node });
    };
    const c = contentRef.current;
    if (typeof c !== 'function') return show(null);
    const result = c();
    if (!isThenable(result)) return show(result);
    timers.current.push(setTimeout(() => show(loadingContent), loadingDelayMs));
    result.then(
      (node) => {
        if (gen !== generation.current) return;
        clearTimers();
        show(node);
      },
      () => { if (gen === generation.current) hide(); },
    );
  };

  const enter = (e: MouseEvent<HTMLElement>) => {
    if (disabled) return;
    inside.current = true;
    triggerEl.current = e.currentTarget;
    pointer.current = { x: e.clientX, y: e.clientY };
    const gen = ++generation.current;
    clearTimers();
    arm();
    if (delayMs <= 0) reveal(gen);
    else timers.current.push(setTimeout(() => reveal(gen), delayMs));
  };
  const triggerProps: TriggerProps = {
    onMouseEnter: enter,
    // React derives mouseenter from the native mouseout of the element the pointer leaves. When
    // that element was removed from under the pointer (e.g. a row's Stage button, its row gone
    // once staged), Chrome sends no mouseout, only a mouseover whose relatedTarget is a node
    // React manages, which React leaves to that missing mouseout: the trigger never gets
    // onMouseEnter. The native mouseover still bubbles here, so it stands in for the lost enter.
    onMouseOver(e) {
      if (!inside.current) enter(e);
    },
    onMouseLeave(e) {
      inside.current = false;
      if (interactive && isInside(tipEl.current, e.relatedTarget)) return;
      hide();
    },
  };
  if (atPointer) {
    // Tracked without re-rendering: the tooltip on screen is moved directly, from its cached size.
    triggerProps.onMouseMove = (e) => {
      pointer.current = { x: e.clientX, y: e.clientY };
      const tip = tipEl.current;
      if (!tip) return;
      const { left, top } = pointerPosition(e.clientX, e.clientY, tipSize.current);
      tip.style.left = `${left}px`;
      tip.style.top = `${top}px`;
    };
  }

  const tooltip = shown
    ? createPortal(
        <div
          ref={tipEl}
          role="tooltip"
          className={`hover-tooltip${interactive ? ' interactive' : ''}${className ? ` ${className}` : ''}`}
          style={atPointer ? { left: shown.anchor.left, top: shown.anchor.top } : { left: shown.anchor.left, top: shown.anchor.bottom + gapFor(interactive) }}
          onMouseLeave={interactive ? (e) => { if (!isInside(triggerEl.current, e.relatedTarget)) hide(); } : undefined}
        >
          {shown.node ?? (typeof content === 'function' ? null : content)}
        </div>,
        document.body,
      )
    : null;

  return { triggerProps, tooltip, open, hide };
}

/** Wraps a single element child, attaching the hover handlers to it. */
export function HoverTooltip({ children, ...opts }: HoverTooltipOptions & { children: ReactElement<Partial<TriggerProps>> }) {
  const { triggerProps, tooltip } = useHoverTooltip(opts);
  const own = children.props;
  return (
    <>
      {cloneElement(children, {
        onMouseEnter: (e: MouseEvent<HTMLElement>) => { own.onMouseEnter?.(e); triggerProps.onMouseEnter(e); },
        onMouseLeave: (e: MouseEvent<HTMLElement>) => { own.onMouseLeave?.(e); triggerProps.onMouseLeave(e); },
        onMouseOver: (e: MouseEvent<HTMLElement>) => { own.onMouseOver?.(e); triggerProps.onMouseOver(e); },
        ...(triggerProps.onMouseMove && { onMouseMove: (e: MouseEvent<HTMLElement>) => { own.onMouseMove?.(e); triggerProps.onMouseMove!(e); } }),
      })}
      {tooltip}
    </>
  );
}
