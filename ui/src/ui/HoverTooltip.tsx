import { cloneElement, useCallback, useEffect, useLayoutEffect, useRef, useState, type MouseEvent, type ReactElement, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import './tooltip.css';

/**
 * A small, local hover tooltip. Plan 1C replaces it with the shared tooltip primitive; until
 * then, anything that needs an instant (or deliberately delayed) tooltip uses this instead of
 * the native `title`, whose OS delay breaks the app-wide "tooltips show immediately" rule.
 *
 * - `delayMs` defaults to 0 (show immediately). The one deliberate exception is the graph's
 *   full commit-message tooltip (~500 ms, spec §8.4).
 * - `interactive`: the pointer may move from the trigger into the tooltip (e.g. to scroll a
 *   long message) without closing it. Otherwise the tooltip ignores the pointer entirely.
 * - `placement`: `'below'` (default) puts it under the trigger, flipped above if it doesn't
 *   fit. `'pointer'` puts it POINTER_GAP px right of the cursor (flipped to its left if it
 *   doesn't fit), at the cursor's height, and follows the pointer while shown. Never
 *   interactive: it's meant to sit next to the pointer without ever catching it (the graph's
 *   message tooltip, feedback F1).
 * - `content` may be a function, called once the delay has elapsed. It can return the content
 *   (e.g. from a cache) or a promise of it: if that takes over `loadingDelayMs` (~100 ms),
 *   `loadingContent` ("Loading…") shows meanwhile. A load that resolves after the pointer left
 *   or the page scrolled shows nothing; a failed load closes the tooltip.
 * - Hidden, and a pending (delayed or loading) tooltip cancelled, on leave, on any scroll
 *   outside the tooltip, and on window resize.
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
  placement?: 'below' | 'pointer';
}

type TriggerProps = { onMouseEnter(e: MouseEvent<HTMLElement>): void; onMouseLeave(e: MouseEvent<HTMLElement>): void; onMouseMove?(e: MouseEvent<HTMLElement>): void };

const GAP = 4;
const EDGE = 8;
/** Horizontal distance between the cursor's hotspot and a `placement: 'pointer'` tooltip: clears
 * the arrow cursor's ~12px-wide body, so the tooltip never sits under the pointer. */
export const POINTER_GAP = 12;
/** An interactive tooltip overlaps its trigger by 1px instead: any gap would be crossed over
 * whatever lies between (e.g. the next row), which counts as leaving and closes it. */
const gapFor = (interactive: boolean) => (interactive ? -1 : GAP);

const isThenable = (v: unknown): v is PromiseLike<ReactNode> => typeof (v as { then?: unknown } | null)?.then === 'function';

/** What the tooltip is placed against: the trigger's box, or (placement 'pointer') the cursor. */
type Anchor = { left: number; top: number; bottom: number };
/** What's on screen: `node` is null for static content, which then renders live from props. */
type Shown = { anchor: Anchor; node: ReactNode | null };

type Size = { width: number; height: number };

/** POINTER_GAP right of the cursor, or left of it when that would leave the window; at the
 * cursor's height, moved up if needed to stay inside the window. */
function pointerPosition(x: number, y: number, { width, height }: Size) {
  let left = x + POINTER_GAP;
  if (left + width > window.innerWidth - EDGE) left = x - POINTER_GAP - width;
  const top = Math.min(y, window.innerHeight - EDGE - height);
  return { left: Math.max(EDGE, left), top: Math.max(EDGE, top) };
}

export function useHoverTooltip({ content, delayMs = 0, interactive: interactiveOpt = false, className, disabled = false, loadingDelayMs = 100, loadingContent = 'Loading…', placement = 'below' }: HoverTooltipOptions) {
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
  const tipEl = useRef<HTMLDivElement>(null);
  // The latest pointer position over the trigger (placement 'pointer').
  const pointer = useRef({ x: 0, y: 0 });
  // The tooltip's size, measured once per content change in the layout effect: a mouse move
  // re-places it from this, without a layout read per move.
  const tipSize = useRef<Size>({ width: 0, height: 0 });
  const contentRef = useRef(content);
  contentRef.current = content;

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
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', hide);
    disarm.current = () => {
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', hide);
    };
  };

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
    const { width, height } = tip.getBoundingClientRect();
    const size = { width, height };
    tipSize.current = size;
    // Content cut at the max height gets `data-clipped`, for a visible cue (e.g. a fade).
    tip.toggleAttribute('data-clipped', tip.scrollHeight > tip.clientHeight);
    let left: number, top: number;
    if (atPointer) {
      ({ left, top } = pointerPosition(pointer.current.x, pointer.current.y, size));
    } else {
      const { anchor } = shown;
      left = Math.max(EDGE, Math.min(anchor.left, window.innerWidth - EDGE - size.width));
      const gap = gapFor(interactive);
      top = anchor.bottom + gap;
      if (top + size.height > window.innerHeight - EDGE) top = Math.max(EDGE, anchor.top - gap - size.height);
    }
    tip.style.left = `${left}px`;
    tip.style.top = `${top}px`;
  }, [shown, interactive, atPointer]);

  const isInside = (el: HTMLElement | null, target: EventTarget | null) => !!el && target instanceof Node && el.contains(target);

  const reveal = (gen: number) => {
    const show = (node: ReactNode | null) => {
      if (gen !== generation.current || !triggerEl.current) return;
      const { x, y } = pointer.current;
      setShown({ anchor: atPointer ? { left: x + POINTER_GAP, top: y, bottom: y } : triggerEl.current.getBoundingClientRect(), node });
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

  const triggerProps: TriggerProps = {
    onMouseEnter(e) {
      if (disabled) return;
      triggerEl.current = e.currentTarget;
      pointer.current = { x: e.clientX, y: e.clientY };
      const gen = ++generation.current;
      clearTimers();
      arm();
      if (delayMs <= 0) reveal(gen);
      else timers.current.push(setTimeout(() => reveal(gen), delayMs));
    },
    onMouseLeave(e) {
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

  return { triggerProps, tooltip, open: shown !== null, hide };
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
        ...(triggerProps.onMouseMove && { onMouseMove: (e: MouseEvent<HTMLElement>) => { own.onMouseMove?.(e); triggerProps.onMouseMove!(e); } }),
      })}
      {tooltip}
    </>
  );
}
