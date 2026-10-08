import { useLayoutEffect, useRef, type RefObject } from 'react';

/** A group's top line: its colour, its chip (null for the group a drop onto a tab would make),
 * and its tabs, hidden (collapsing) ones included. A dragged tab isn't one of them: it's the
 * `ghost` of the group it previews joining (else null), which the line takes in as it eases in.
 * `lifted`: the line of a group dragged by its chip, drawn above its lifted items. */
export interface LineSpec {
  id: string;
  color: string;
  chip: string | null;
  tabs: string[];
  ghost?: string | null;
  lifted?: boolean;
}

export interface Span {
  left: number;
  right: number;
}

/** Where a released item shows while it slides into its slot (`useTabDrag`'s `slotWindow`): only
 * its part inside its unit's slot span. */
export interface SlotWindow {
  span: [number, number];
}

/** Over the first this many px of its tabs' total width, the chip's own piece of the line grows
 * (expanding) or shrinks into the chip (collapsing), so the line comes out of the chip and goes
 * back into it. */
export const LINE_RAMP = 40;

/** Dispatched on the strip by code that starts animating its items after a render (a drop's
 * slides): the lines follow them. */
export const STRIP_MOTION = 'tg-strip-motion';

/** How long a dragged tab's share of a line takes to ease in or out: the strip's slide
 * (`SLIDE_MS`, `--tab-slide`), so it moves with the tabs making room. */
export const GHOST_MS = 150;

/**
 * Where a group's line runs: from its chip's pill (the chip's left edge as drawn) through its last
 * tab, over whatever lies between. With its tabs collapsed to no width, nowhere.
 */
export function lineSpan(pill: Span | null, chip: Span | null, tabs: Span[]): Span | null {
  const shown = tabs.filter((b) => b.right - b.left > 0.5);
  const total = shown.reduce((s, b) => s + b.right - b.left, 0);
  let left = Infinity;
  let right = -Infinity;
  for (const b of shown) {
    left = Math.min(left, b.left);
    right = Math.max(right, b.right);
  }
  if (pill && chip) {
    // The chip's piece, and how far short of the chip's end it falls: the line ends that much
    // short of the tabs too, so it ends up a point at the pill's left edge.
    const full = chip.right - pill.left;
    const piece = full * Math.min(1, total / LINE_RAMP);
    left = Math.min(left, pill.left);
    right = Math.max(pill.left + piece, right - (full - piece));
  }
  return right - left > 0.5 ? { left, right } : null;
}

/** `t` of the way from `a` to `b`; a missing end is a point at the other's left end (where the
 * chip is), so a line grows out of it and shrinks back into it. */
export function blendSpan(a: Span | null, b: Span | null, t: number): Span | null {
  if (!a && !b) return null;
  const from = a ?? { left: b!.left, right: b!.left };
  const to = b ?? { left: a!.left, right: a!.left };
  const s = { left: from.left + (to.left - from.left) * t, right: from.right + (to.right - from.right) * t };
  return s.right - s.left > 0.5 ? s : null;
}

/** An item's box as drawn, cut to its slot window if it's sliding into one. */
export function visiblePart(box: Span, w: SlotWindow | null): Span {
  return w ? { left: Math.max(box.left, w.span[0]), right: Math.min(box.right, w.span[1]) } : box;
}

/** A dragged tab easing into a group's line (`to` 1) or out of it (`to` 0), from `from`, since
 * `start` (ms). */
export interface Ghost {
  tab: string;
  from: number;
  to: number;
  start: number;
}

/** How much of the ghost the line takes in at `now`: eased out, as the strip's slides. */
export function ghostShare(g: Ghost, now: number, ms = GHOST_MS): number {
  const p = ms > 0 ? Math.min(1, Math.max(0, (now - g.start) / ms)) : 1;
  return g.from + (g.to - g.from) * (1 - (1 - p) ** 3);
}

/**
 * A group's ghost after a render: `ghost`, the tab the drag now previews in the group (or null),
 * `tabs` its members, `was` its members the render before. A tab that was already a member (the
 * drag just started) is in at once; one arriving eases in from where its share is, and one
 * leaving eases out, until it's a member again (the drop committed) or gone.
 */
export function trackGhost(g: Ghost | null, ghost: string | null, tabs: string[], was: string[], now: number, ms = GHOST_MS): Ghost | null {
  if (ghost) {
    if (g?.tab === ghost) return g.to === 1 ? g : { tab: ghost, from: ghostShare(g, now, ms), to: 1, start: now };
    const member = was.includes(ghost);
    return { tab: ghost, from: member ? 1 : 0, to: 1, start: now };
  }
  if (!g || tabs.includes(g.tab)) return null;
  if (g.to === 0) return g;
  return { tab: g.tab, from: ghostShare(g, now, ms), to: 0, start: now };
}

/** A group's line in a frame, its ghost in `share` of the way (its box `ghost`, as drawn): the
 * line, and its part over the ghost (drawn above the lifted tab, which covers the other lines). */
export function ghostLine(pill: Span | null, chip: Span | null, tabs: Span[], ghost: Span | null, share: number): { line: Span | null; over: Span | null } {
  const without = lineSpan(pill, chip, tabs);
  if (!ghost || share <= 0) return { line: without, over: null };
  const line = blendSpan(without, lineSpan(pill, chip, [...tabs, ghost]), share);
  const over = line && { left: Math.max(line.left, ghost.left), right: Math.min(line.right, ghost.right) };
  return { line, over: over && over.right - over.left > 0.5 ? over : null };
}

const span = (el: Element): Span => {
  const r = el.getBoundingClientRect();
  return { left: r.left, right: r.right };
};

const reducedMotion = () => typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

const place = (el: HTMLElement | undefined, s: Span | null, origin: number) => {
  if (!el) return;
  el.style.transform = `translateX(${s ? s.left - origin : 0}px)`;
  el.style.width = `${s ? s.right - s.left : 0}px`;
};

/**
 * Each group's top line, one element over its whole span, above the tabs and their separators: so
 * it's one unbroken stroke. Measured from the strip's items as drawn (after each render, and every
 * frame while anything in the strip moves: a drag, a drop's slide, a group collapsing or
 * expanding), so it grows and shrinks, and slides, with them. A dragged tab joining a group eases
 * into its line, and out of it as it leaves; the lifted tab covers the other lines, and its own
 * group's line shows over it (`.tg-over`, fading with its share).
 */
export function GroupLines({ strip, specs, moving, slotWindow }: {
  strip: RefObject<HTMLElement | null>;
  specs: LineSpec[];
  /** A drag is on: keep measuring. */
  moving: boolean;
  slotWindow(key: string): SlotWindow | null;
}) {
  const refs = useRef(new Map<string, HTMLDivElement>());
  const overs = useRef(new Map<string, HTMLDivElement>());
  const ghosts = useRef(new Map<string, Ghost>());
  const members = useRef(new Map<string, string[]>());
  useLayoutEffect(() => {
    const root = strip.current;
    if (!root) return;
    const ms = reducedMotion() ? 0 : GHOST_MS;
    const now0 = performance.now();
    for (const id of [...ghosts.current.keys()]) if (!specs.some((s) => s.id === id)) ghosts.current.delete(id);
    for (const spec of specs) {
      const g = trackGhost(ghosts.current.get(spec.id) ?? null, spec.ghost ?? null, spec.tabs, members.current.get(spec.id) ?? spec.tabs, now0, ms);
      if (g) ghosts.current.set(spec.id, g);
      else ghosts.current.delete(spec.id);
      members.current.set(spec.id, spec.tabs);
    }
    const tabBox = (id: string): Span | null => {
      const el = root.querySelector(`.tab[data-tab-id="${CSS.escape(id)}"]`);
      return el && visiblePart(span(el), slotWindow(`tab:${id}`));
    };
    /** Places every line; true while a ghost is still easing. */
    const placeAll = (): boolean => {
      const origin = root.getBoundingClientRect().left;
      const now = performance.now();
      let easing = false;
      for (const spec of specs) {
        const chip = spec.chip ? root.querySelector(`[data-strip-key="chip:${CSS.escape(spec.chip)}"]`) : null;
        const pill = chip?.querySelector('.tg-chip-pill') ?? null;
        const tabs = spec.tabs.flatMap((id) => tabBox(id) ?? []);
        const g = ghosts.current.get(spec.id);
        let share = 0;
        if (g) {
          share = ghostShare(g, now, ms);
          if (share === g.to && g.to === 0) ghosts.current.delete(spec.id);
          else if (share !== g.to) easing = true;
        }
        const { line, over } = ghostLine(pill && span(pill), chip && span(chip), tabs, g ? tabBox(g.tab) : null, share);
        place(refs.current.get(spec.id), line, origin);
        const o = overs.current.get(spec.id);
        place(o, over, origin);
        if (o) o.style.opacity = String(share);
      }
      return easing;
    };
    let frame = 0;
    const tick = () => {
      const easing = placeAll();
      const busy = moving || easing || (typeof root.getAnimations === 'function' && root.getAnimations({ subtree: true }).length > 0);
      frame = busy ? requestAnimationFrame(tick) : 0;
    };
    tick();
    const kick = () => { if (!frame) tick(); };
    root.addEventListener(STRIP_MOTION, kick);
    const resized = typeof ResizeObserver === 'function' ? new ResizeObserver(() => placeAll()) : null;
    resized?.observe(root);
    return () => {
      cancelAnimationFrame(frame);
      root.removeEventListener(STRIP_MOTION, kick);
      resized?.disconnect();
    };
  });
  const keep = (m: Map<string, HTMLDivElement>, id: string) => (el: HTMLDivElement | null) => {
    if (el) m.set(id, el);
    else m.delete(id);
  };
  return (
    <>
      {specs.map((s) => (
        <div key={s.id} className={`tg-line${s.lifted ? ' lifted' : ''}`} data-group-color={s.color} aria-hidden ref={keep(refs.current, s.id)} />
      ))}
      {specs.map((s) => (
        <div key={`over:${s.id}`} className="tg-over" data-group-color={s.color} aria-hidden ref={keep(overs.current, s.id)} />
      ))}
    </>
  );
}
