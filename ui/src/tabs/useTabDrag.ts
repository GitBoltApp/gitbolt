import { useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react';
import { flushSync } from 'react-dom';
import { STRIP_MOTION, type SlotWindow } from './GroupLines';

/** The dragged units' layout boxes when the drag started (client px, untransformed). */
export interface StripGeometry {
  lefts: number[];
  widths: number[];
  /** The strip's own client box: the dragged unit never leaves it. */
  stripLeft: number;
  stripRight: number;
}

/** The dragged unit's offset for a pointer offset `dx`, clamped so it stays over the units
 * themselves and inside the strip. */
export function clampDx(g: StripGeometry, from: number, dx: number): number {
  const n = g.lefts.length;
  const lo = Math.max(g.stripLeft, g.lefts[0]) - g.lefts[from];
  const hi = Math.min(g.stripRight, g.lefts[n - 1] + g.widths[n - 1]) - (g.lefts[from] + g.widths[from]);
  return Math.min(Math.max(dx, Math.min(lo, 0)), Math.max(hi, 0));
}

/** How far into a tab (from the side the drag comes from) its middle zone starts: the middle 40%
 * of a tab that takes a drop onto it (making a group) is that; its edges stay "reorder". */
export const ONTO_EDGE = 0.3;

/**
 * Where a release at offset `dx` lands: the slot `to`, and `onto`, the unit dropped onto (or
 * null). The dragged unit passes a neighbour once its leading edge (not its centre: clamped at the
 * end of the strip, a wide tab's centre never reaches a narrow last tab's midpoint) crosses that
 * neighbour's midpoint, or, for a neighbour that takes a drop (`canOnto`), its far edge zone;
 * its leading edge in such a neighbour's middle zone is a drop onto it.
 */
export function dropAt(g: StripGeometry, from: number, dx: number, canOnto: (j: number) => boolean = () => false): { to: number; onto: number | null } {
  const n = g.lefts.length;
  let to = from;
  if (dx > 0) {
    const edge = g.lefts[from] + g.widths[from] + dx;
    for (let j = from + 1; j < n; j++) {
      const l = g.lefts[j], w = g.widths[j], grab = canOnto(j);
      if (edge > l + w * (grab ? 1 - ONTO_EDGE : 0.5)) { to = j; continue; }
      if (grab && edge >= l + w * ONTO_EDGE) return { to, onto: j };
      break;
    }
  } else if (dx < 0) {
    const edge = g.lefts[from] + dx;
    for (let j = from - 1; j >= 0; j--) {
      const l = g.lefts[j], w = g.widths[j], grab = canOnto(j);
      if (edge < l + w * (grab ? ONTO_EDGE : 0.5)) { to = j; continue; }
      if (grab && edge <= l + w * (1 - ONTO_EDGE)) return { to, onto: j };
      break;
    }
  }
  return { to, onto: null };
}

/** The target slot alone (no drop onto a unit). */
export const targetIndex = (g: StripGeometry, from: number, dx: number): number => dropAt(g, from, dx).to;

/** A strip item a dragged tab moves among, as laid out when the drag started (client px). */
export type DragBox =
  | { kind: 'tab'; group: string | null; left: number; width: number }
  | { kind: 'chip'; group: string; left: number; width: number }
  /** A collapsed group (its chip, and its active tab if that shows): passed whole, never entered. */
  | { kind: 'block'; left: number; width: number };

/** Where a dragged tab lands: in the gap before `others[gap]` (the strip's items but the dragged
 * one), in `group` (null: in none); or onto the tab `items[onto]`, which makes a group of the two. */
export type TabDrop = { gap: number; group: string | null } | { onto: number };

/** Past this point (the dragged tab's left edge) in the direction of the drag, it lands there. */
interface Step { x: number; drop: TabDrop }

/** A slot at a group's edge (its first or last slot, or the one just outside it) is at least this
 * fraction of the dragged tab's width wide, in pointer travel: the same 40% as a tab's "onto"
 * middle. At most `ZONE_MAX` px: travel is hand movement, which a long name doesn't make any less
 * precise, and a wider zone only drifts the tab further from the slot it previews. */
export const ZONE = 0.4;
export const ZONE_MAX = 44;
/** A zone is left only this far past its edge (either way), so a pointer resting on the edge
 * doesn't flicker between the two. Every zone is wider than twice this. */
export const HYSTERESIS = 10;

const sameDrop = (a: TabDrop, b: TabDrop) =>
  'onto' in a ? 'onto' in b && a.onto === b.onto : !('onto' in b) && a.gap === b.gap && a.group === b.group;

/**
 * The points a tab dragged from `items[from]` passes on its way right and on its way left, in
 * order. Measured on its leading edge (its left edge against the other items laid out without it):
 * - a tab: its midpoint; an ungrouped one takes a drop onto its middle 40% (`ONTO_EDGE`);
 * - a group's chip, from outside: its midpoint, into the group's first slot;
 * - a group's end, from outside: the leading edge 30% into its last tab, into its last slot;
 * - leaving a group: the leading edge past the group's outer edge as the slot it's in lays it out
 *   (past its chip's far side, or past where its last slot ends), into the slot just outside;
 * - a collapsed group: its midpoint, passed whole.
 * Each point falls there unless that leaves the zone before it narrower than its minimum (`edge`:
 * a slot at a group's edge, `ZONE` of the tab's width; any other, `2 * HYSTERESIS`): then it's
 * pushed on by the difference. Later points aren't, so the tab never drifts far from its slot.
 */
function tabSteps(items: DragBox[], from: number): { right: Step[]; left: Step[]; edge: (d: TabDrop) => boolean; zone: number } {
  const dragged = items[from];
  const w = dragged.width;
  const own = dragged.kind === 'tab' ? dragged.group : null;
  const others = items.flatMap((b, i) => (i === from ? [] : [{ ...b, left: i > from ? b.left - w : b.left, index: i }]));
  const isTabOf = (j: number, g: string) => { const o = others[j]; return o?.kind === 'tab' && o.group === g; };
  /** A slot at a group's edge: its first (after its chip) or its last, or the one just outside it. */
  const edge = (d: TabDrop): boolean => {
    if ('onto' in d) return false;
    const prev = others[d.gap - 1];
    if (d.group) return (prev?.kind === 'chip' && prev.group === d.group) || !isTabOf(d.gap, d.group);
    return (prev?.kind === 'tab' && prev.group !== null) || others[d.gap]?.kind === 'chip';
  };
  const zone = Math.min(ZONE * w, ZONE_MAX);
  const minOf = (d: TabDrop) => (edge(d) ? zone : 2 * HYSTERESIS);
  // Its own slot, at a group's edge, holds it as far either way before anything changes.
  const restMin = edge({ gap: from, group: own }) ? zone : 0;

  const right: Step[] = [];
  let lastX = dragged.left;
  let min = restMin;
  const pushRight = (x: number, drop: TabDrop) => {
    lastX = Math.max(x, lastX + min);
    min = minOf(drop);
    right.push({ x: lastX, drop });
  };
  let k = from;
  let grp = own;
  for (;;) {
    const next = others[k];
    if (grp !== null && !isTabOf(k, grp)) {
      const last = others[k - 1];
      pushRight(last.left + last.width, { gap: k, group: null });
      grp = null;
      continue;
    }
    if (!next) break;
    if (next.kind === 'tab' && next.group === null) {
      pushRight(next.left + next.width * ONTO_EDGE, { onto: next.index });
      pushRight(next.left + next.width * (1 - ONTO_EDGE), { gap: k + 1, group: null });
    } else {
      grp = next.kind === 'block' ? null : next.group;
      pushRight(next.left + next.width / 2, { gap: k + 1, group: grp });
    }
    k++;
  }

  const left: Step[] = [];
  lastX = dragged.left;
  min = restMin;
  const pushLeft = (x: number, drop: TabDrop) => {
    lastX = Math.min(x, lastX - min);
    min = minOf(drop);
    left.push({ x: lastX, drop });
  };
  k = from;
  grp = own;
  for (;;) {
    const prev = others[k - 1];
    if (!prev) break;
    if (prev.kind === 'tab' && prev.group !== null && prev.group !== grp) {
      grp = prev.group;
      pushLeft(prev.left + prev.width * (1 - ONTO_EDGE), { gap: k, group: grp });
      continue;
    }
    if (prev.kind === 'chip' && prev.group === grp) {
      grp = null;
      pushLeft(prev.left, { gap: k - 1, group: null });
    } else if (prev.kind === 'tab' && prev.group === null) {
      pushLeft(prev.left + prev.width * (1 - ONTO_EDGE), { onto: prev.index });
      pushLeft(prev.left + prev.width * ONTO_EDGE, { gap: k - 1, group: null });
    } else {
      if (prev.kind !== 'tab') grp = null;
      pushLeft(prev.left + prev.width / 2, { gap: k - 1, group: grp });
    }
    k--;
  }
  return { right, left, edge, zone };
}

/** Where a tab dragged from `items[from]` by `dx` lands. `held`, where it was previewed last (none
 * at the start), stays until `dx` is `HYSTERESIS` past its zone. */
export function tabDropAt(items: DragBox[], from: number, dx: number, held?: TabDrop): TabDrop {
  const { right, left } = tabSteps(items, from);
  const b = items[from];
  const at = (d: number): TabDrop => {
    const x = b.left + d;
    let drop: TabDrop = { gap: from, group: b.kind === 'tab' ? b.group : null };
    if (d > 0) for (const s of right) { if (x > s.x) drop = s.drop; else break; }
    if (d < 0) for (const s of left) { if (x < s.x) drop = s.drop; else break; }
    return drop;
  };
  const drop = at(dx);
  if (!held || sameDrop(drop, held)) return drop;
  return sameDrop(at(dx - HYSTERESIS), held) || sameDrop(at(dx + HYSTERESIS), held) ? held : drop;
}

/** How far a tab dragged from `items[from]` can go (its `dx` bounds): over the strip, the empty
 * space after the tabs included (a drop zone), and past the strip's ends as far as it takes to
 * reach the first and the last slot (leaving a group at the strip's end): half that slot's zone
 * on, if it's at a group's edge, so a pointer resting there holds it. */
export function tabDragRange(items: DragBox[], from: number, stripLeft: number, stripRight: number): { lo: number; hi: number } {
  const { right, left, edge, zone } = tabSteps(items, from);
  const b = items[from];
  const reach = (s: Step) => (edge(s.drop) ? zone / 2 : 1);
  const l = left.at(-1);
  const r = right.at(-1);
  const lo = Math.min(stripLeft, l ? l.x - reach(l) : Infinity) - b.left;
  const hi = Math.max(stripRight - b.width, r ? r.x + reach(r) : -Infinity) - b.left;
  return { lo: Math.min(lo, 0), hi: Math.max(hi, 0) };
}

/** How far each strip item (a tab, a group's chip) moves to show `order`, the strip a release
 * would give: laid end to end from `start`, by the widths measured when the drag started. */
export function layoutOffsets(order: string[], lefts: Record<string, number>, widths: Record<string, number>, start: number): Record<string, number> {
  const out: Record<string, number> = {};
  let x = start;
  for (const k of order) {
    if (!(k in lefts)) continue;
    out[k] = x - lefts[k];
    x += widths[k];
  }
  return out;
}

/** The strip when a drag starts: each item's box by its key (`data-strip-key`; client px,
 * untransformed), and the strip's own edges. */
export interface StripMeasure {
  lefts: Record<string, number>;
  widths: Record<string, number>;
  stripLeft: number;
  stripRight: number;
}

/** What a release at some offset gives. */
export interface DropPreview {
  /** The strip's item keys after it. */
  order: string[];
  /** The group colour the dragged unit shows there (the "sticky" preview), and that group. */
  color: string | null;
  group: string | null;
  /** The item a release drops onto (its key), which takes the drop at once; else null. */
  onto: string | null;
  /** Makes the change, as one update; null when there is none. */
  commit: (() => void) | null;
}

/** What a drag moves and what a release does, built when the press starts (`TabBar`). */
export interface DragPlan {
  /** The dragged unit's item keys. */
  moving: string[];
  /** From the strip as measured: the dragged unit's offset bounds, and what a release at offset
   * `dx` gives (null: no drag). */
  locate(m: StripMeasure): { lo: number; hi: number; at(dx: number): DropPreview } | null;
}

/** A plan's `locate` for a unit that moves as a block among `units` (each its item keys), passing
 * each at its midpoint: `order(to)` and `drop(to)` for a release at slot `to`. */
export function unitLocator(units: string[][], from: number, m: StripMeasure, preview: (to: number) => { order: string[]; color: string | null; group: string | null }, drop: (to: number) => void): ReturnType<DragPlan['locate']> {
  if (units.some((u) => !u.every((k) => k in m.lefts))) return null;
  const g: StripGeometry = {
    lefts: units.map((u) => m.lefts[u[0]]),
    widths: units.map((u) => u.reduce((s, k) => s + m.widths[k], 0)),
    stripLeft: m.stripLeft,
    stripRight: m.stripRight,
  };
  return {
    lo: clampDx(g, from, -Infinity),
    hi: clampDx(g, from, Infinity),
    at: (dx) => {
      const to = targetIndex(g, from, dx);
      return { ...preview(to), onto: null, commit: to === from ? null : () => drop(to) };
    },
  };
}

const THRESHOLD = 4;
/** Matches `--tab-slide` in tabs.css (the strip's slides). */
export const SLIDE_MS = 150;

type Phase = 'drag' | 'settle';
export interface Drag {
  phase: Phase;
  dx: number;
  /** The dragged unit's item keys. */
  moving: string[];
  offsets: Record<string, number>;
  /** The item a release would drop onto. */
  onto: string | null;
  color: string | null;
  /** The group the dragged unit shows in (`DropPreview.group`). */
  group: string | null;
  /** Items a release removes (the chip of a group the dragged tab was the last of). */
  gone: string[];
}

const reducedMotion = () => typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

const visualLefts = (strip: HTMLElement): Record<string, number> =>
  Object.fromEntries([...strip.querySelectorAll<HTMLElement>('[data-strip-key]')].map((el) => [el.dataset.stripKey!, el.getBoundingClientRect().left]));

/**
 * After a commit: each item slides from where it was on screen (`before`, the drag's preview) to
 * where the new order puts it, and a new one (a new group's chip) fades in. A settled drop
 * previewed the new order exactly, so nothing moves; a drop onto a tab adds a chip the preview
 * didn't have.
 */
function slideFrom(strip: HTMLElement, before: Record<string, number>) {
  const els = [...strip.querySelectorAll<HTMLElement>('[data-strip-key]')];
  // Chromium can start a transition from the dropped transform to none on an item the commit
  // didn't move (seen on a chip), sliding it in from where it was before the drag: the preview
  // already showed it in place, so none of that.
  for (const el of els) for (const a of transformSlides(el)) a.cancel();
  if (reducedMotion() || !els.length || typeof els[0].animate !== 'function') return;
  const timing = { duration: SLIDE_MS, easing: 'ease-out' };
  // A new item (a new group's chip) grows from no width, pushing what follows along: nothing
  // slides over it. Started first, so the items after it measure where they were.
  for (const el of els) {
    if (el.dataset.stripKey! in before) continue;
    const s = getComputedStyle(el);
    el.animate({ width: ['0px', s.width], paddingLeft: ['0px', s.paddingLeft], paddingRight: ['0px', s.paddingRight], opacity: [0, 1] }, timing);
  }
  for (const el of els) {
    const was = before[el.dataset.stripKey!];
    if (was === undefined) continue;
    const d = was - el.getBoundingClientRect().left;
    if (Math.abs(d) >= 0.5) el.animate({ transform: [`translateX(${d}px)`, 'none'] }, timing);
  }
  strip.dispatchEvent(new Event(STRIP_MOTION));
}

/** The CSS transitions of `transform` running on `el` (none where the browser can't say). */
const transformSlides = (el: Element): Animation[] =>
  typeof el.getAnimations === 'function' ? el.getAnimations().filter((a) => (a as CSSTransition).transitionProperty === 'transform') : [];

/**
 * Pointer-driven reordering of the tab strip (spec §6.2, no DnD library): a tab, or a group by its
 * chip. Past a 4 px threshold the pressed unit follows the pointer and the other items slide to
 * show where a release puts it. A release slides it into that slot (onto a tab's middle: beside
 * it, making a group) and then commits the move, a new group's chip growing in; Esc slides
 * everything back.
 */
export function useTabDrag() {
  const [drag, setDrag] = useState<Drag | null>(null);
  const justDragged = useRef(false);
  const settling = useRef(false);
  const cleanup = useRef<(() => void) | null>(null);
  /** While a released unit slides in: how each of its items shows (its unit's slot span, client px). */
  const windows = useRef(new Map<string, SlotWindow>());
  useEffect(() => () => cleanup.current?.(), []);

  /** The click a release dispatches (if it lands on the unit) comes in the same task; past that,
   * clicks count again. */
  const swallowClick = () => {
    justDragged.current = true;
    window.setTimeout(() => { justDragged.current = false; }, 0);
  };

  const onPointerDown = (e: ReactPointerEvent<HTMLElement>, makePlan: () => DragPlan) => {
    if (e.button !== 0 || settling.current) return;
    const strip = e.currentTarget.closest<HTMLElement>('[role="tablist"]');
    if (!strip) return;
    const plan = makePlan();
    const lefts: Record<string, number> = {};
    const widths: Record<string, number> = {};
    for (const el of strip.querySelectorAll<HTMLElement>('[data-strip-key]')) {
      const r = el.getBoundingClientRect();
      lefts[el.dataset.stripKey!] = r.left;
      widths[el.dataset.stripKey!] = r.width;
    }
    const keys = Object.keys(lefts);
    if (!keys.length || !plan.moving.every((k) => k in lefts)) return;
    const sr = strip.getBoundingClientRect();
    const loc = plan.locate({ lefts, widths, stripLeft: sr.left, stripRight: sr.right });
    if (!loc) return;
    const start = Math.min(...keys.map((k) => lefts[k]));
    const { moving } = plan;
    const rest = loc.at(0);
    const x0 = e.clientX;
    let active = false;
    let last = rest;
    let lastDx = 0;

    const state = (phase: Phase, dx: number, t: DropPreview): Drag => ({
      phase, dx, moving, offsets: layoutOffsets(t.order, lefts, widths, start), onto: t.onto, color: t.color, group: t.group,
      gone: keys.filter((k) => !t.order.includes(k)),
    });
    /**
     * The dragged unit's slide from where the release left it into its slot. Each of its items
     * shows only within the unit's slot (a clip that moves against the slide), so it never covers
     * a neighbour: a tab "drops in" to its place. Its group's line follows its part inside the
     * slot meanwhile (`windows`, which `GroupLines` measures it by), frame by frame. The
     * animations, or none where there's no Web Animations API (the CSS transform then just
     * changes).
     */
    const slideIn = (s: Drag): Animation[] => {
      const finals = moving.map((k) => lefts[k] + s.offsets[k]);
      const u0 = Math.min(...finals);
      const u1 = Math.max(...moving.map((k, i) => finals[i] + widths[k]));
      return moving.flatMap((k, i) => {
        const el = strip.querySelector<HTMLElement>(`[data-strip-key="${CSS.escape(k)}"]`);
        if (!el || typeof el.animate !== 'function' || Math.abs(lastDx - s.offsets[k]) < 0.5) return [];
        windows.current.set(k, { span: [u0, u1] });
        const now = lefts[k] + lastDx;
        const clip = (x: number) => `inset(-20px ${x + widths[k] - u1}px -20px ${u0 - x}px)`;
        return [el.animate(
          { transform: [`translateX(${lastDx}px)`, `translateX(${s.offsets[k]}px)`], clipPath: [clip(now), clip(finals[i])] },
          { duration: SLIDE_MS, easing: 'ease-out' },
        )];
      });
    };
    /** The change, in one render with the dropped transforms (a store update and a state update
     * could otherwise land in separate renders: a one-frame flash); then anything the preview
     * didn't show slides from where it was. */
    const commit = (t: DropPreview) => {
      const before = visualLefts(strip);
      flushSync(() => {
        t.commit?.();
        setDrag(null);
      });
      slideFrom(strip, before);
    };
    const stop = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', cancel);
      window.removeEventListener('keydown', key, true);
      cleanup.current = null;
    };
    /** Animate to the final state (the preview's colour kept), then (after the slide) commit: the
     * unit is already where the new order puts it, so nothing jumps. */
    const settle = (t: DropPreview) => {
      stop();
      settling.current = true;
      const s = state('settle', 0, t);
      flushSync(() => setDrag(s));
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        settling.current = false;
        cleanup.current = null;
        windows.current.clear();
        commit(t);
      };
      if (reducedMotion()) return finish();
      // When the slides end (they're the clock, however fast they run), else after their time.
      const slides = [...[...strip.querySelectorAll('[data-strip-key]')].flatMap(transformSlides), ...slideIn(s)];
      const timer = window.setTimeout(finish, slides.length ? SLIDE_MS * 20 : SLIDE_MS);
      if (slides.length) void Promise.allSettled(slides.map((a) => a.finished)).then(finish);
      cleanup.current = () => { done = true; window.clearTimeout(timer); windows.current.clear(); }; // unmounted mid-slide: drop the move
    };
    const move = (ev: PointerEvent) => {
      const raw = ev.clientX - x0;
      if (!active && Math.abs(raw) < THRESHOLD) return;
      active = true;
      lastDx = Math.min(Math.max(raw, loc.lo), loc.hi);
      last = loc.at(lastDx);
      setDrag(state('drag', lastDx, last));
    };
    const up = () => {
      if (!active) return stop();
      swallowClick();
      settle(last);
    };
    const cancel = () => {
      if (!active) return stop();
      settle(rest);
    };
    const key = (ev: KeyboardEvent) => {
      if (ev.key !== 'Escape' || !active) return;
      ev.preventDefault();
      ev.stopPropagation();
      settle(rest);
      // The release that follows mustn't click the unit either.
      window.addEventListener('pointerup', swallowClick, { once: true });
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', cancel);
    window.addEventListener('keydown', key, true);
    cleanup.current = stop;
  };

  /** True once right after a drag ends: the click that follows must not activate the unit. */
  const consumeClick = () => {
    const was = justDragged.current;
    justDragged.current = false;
    return was;
  };

  /** The transform for strip item `key` during a drag (undefined when nothing moves it); an item
   * the release removes fades out. */
  const itemStyle = (key: string): CSSProperties | undefined => {
    if (!drag) return undefined;
    if (drag.gone.includes(key)) return { opacity: 0 };
    const x = drag.phase === 'drag' && drag.moving.includes(key) ? drag.dx : drag.offsets[key] ?? 0;
    return x ? { transform: `translateX(${x}px)` } : undefined;
  };

  /** Where item `key` shows while it slides into its slot: its unit's slot span (else null). */
  const slotWindow = (key: string): SlotWindow | null => windows.current.get(key) ?? null;

  return { drag, onPointerDown, consumeClick, itemStyle, slotWindow };
}
