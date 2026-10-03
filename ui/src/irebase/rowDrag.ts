import { useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react';
import { registerKeys } from '../ui/keyRouter';
import { DRAG_THRESHOLD, swallowNextClick, swallowReleaseClick } from './chipDrag';

/* A drag moves a group (UX2 E.3): the pressed row, or every selected row when the pressed one is
   selected. The group is a block of its rows, in their order; the others are the list without
   it. Indices are the list's; `group` is sorted. Heights only: the rows are contiguous. */

const sum = (xs: readonly number[]) => xs.reduce((a, b) => a + b, 0);
/** The height of the group's rows above row `i`: `i`'s offset in the block. */
const groupAbove = (heights: readonly number[], group: readonly number[], i: number) => sum(group.filter((g) => g < i).map((g) => heights[g]));

/** The slot (among the other rows) the group lands in when the pressed row `from` is `dy` from
 * where it was: the block's top passes a row once it crosses that row's midpoint. For one row,
 * the tab drag's rule (its leading edge crosses the neighbour's midpoint). */
export function groupTarget(heights: readonly number[], group: readonly number[], from: number, dy: number): number {
  const top = sum(heights.slice(0, from)) + dy - groupAbove(heights, group, from);
  const inGroup = new Set(group);
  let y = 0;
  let slot = 0;
  for (let i = 0; i < heights.length; i++) {
    if (inGroup.has(i)) continue;
    if (top <= y + heights[i] / 2) break;
    slot++;
    y += heights[i];
  }
  return slot;
}

/** How far each row moves to show the order a release at slot `to` would make (the live
 * insertion gap). A group row's entry is the offset of its place in the landed block. */
export function slotShifts(heights: readonly number[], group: readonly number[], to: number): number[] {
  const inGroup = new Set(group);
  const rest = heights.map((_, i) => i).filter((i) => !inGroup.has(i));
  const out = heights.map(() => 0);
  let y = 0;
  for (const i of [...rest.slice(0, to), ...group, ...rest.slice(to)]) {
    out[i] = y - sum(heights.slice(0, i));
    y += heights[i];
  }
  return out;
}

interface Drag { from: number; group: number[]; oids: string[]; to: number; dy: number; heights: number[] }

/** What a press on starts nothing of the row's: the row's controls (the action dropdown, the
 * message editor, a chip's × and "+", the new branch input). A free chip starts its own drag. */
const OWN_PRESS = 'button, input, textarea, select, a, [contenteditable="true"], .irebase-action, .irebase-message-editor, .irebase-chip-input, .irebase-chip-more, .irebase-chips-all';

/** Rows reordered by a drag from anywhere on them (spec #3 §4.1, the tab drag of #2 UX round 2;
 * UX R1.2), the handle being only its affordance. A press without DRAG_THRESHOLD of travel is a
 * click (it selects). A press on a selected row drags the whole selection (UX2 E.3): it lands
 * together, in its order. `list`: the `<ol>` whose `[data-irebase-row]` children are the rows. */
export function useRowDrag(list: React.RefObject<HTMLElement | null>, onMove: (oids: string[], to: number) => void) {
  const [drag, setDrag] = useState<Drag | null>(null);
  const off = useRef<(() => void) | null>(null);
  useEffect(() => () => off.current?.(), []);
  /** `selection`: the selected rows' oids; the group when the pressed row is one of them. */
  const onPointerDown = (e: ReactPointerEvent<HTMLElement>, index: number, selection: readonly string[] = []) => {
    if (e.button !== 0 || !list.current) return;
    if (e.target instanceof Element && e.target.closest(OWN_PRESS)) return;
    const els = [...list.current.querySelectorAll<HTMLElement>('[data-irebase-row]')];
    const heights = els.map((el) => el.getBoundingClientRect().height);
    const all = els.map((el) => el.dataset.oid ?? '');
    const picked = new Set(selection);
    const group = picked.size > 1 && picked.has(all[index]) ? all.flatMap((o, i) => (picked.has(o) ? [i] : [])) : [index];
    const oids = group.map((i) => all[i]);
    const home = groupTarget(heights, group, index, 0);
    const x0 = e.clientX;
    const y0 = e.clientY;
    let active = false;
    let last = { to: home, dy: 0 };
    const stop = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', stop);
      unkey();
      off.current = null;
      setDrag(null);
    };
    const move = (ev: PointerEvent) => {
      const dy = ev.clientY - y0;
      if (!active && Math.hypot(ev.clientX - x0, dy) < DRAG_THRESHOLD) return;
      // Past the threshold it's a drag: no text selection, no scrolling (a press below it stays
      // a plain click, focus and all).
      ev.preventDefault();
      active = true;
      last = { to: groupTarget(heights, group, index, dy), dy };
      setDrag({ from: index, group, oids, ...last, heights });
    };
    const up = () => {
      const to = last.to;
      stop();
      if (!active) return;
      swallowNextClick();
      // A scattered group dropped where it was still closes up (moveRows: no change otherwise).
      if (to !== home || group.length > 1) onMove(oids, to);
    };
    // The menu layer, above the editor's own keys (overlay): Esc puts the rows back and nothing else.
    const unkey = registerKeys('menu', (ev) => {
      if (ev.key !== 'Escape' || !active) return;
      ev.preventDefault();
      stop();
      swallowReleaseClick();
      return 'handled';
    });
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', stop);
    off.current = stop;
  };
  const style = (i: number): CSSProperties | undefined => {
    if (!drag) return undefined;
    const { heights, group, from, dy } = drag;
    // The group follows the pointer as it is (no transition lag), closed up around the pressed
    // row; the others slide.
    if (group.includes(i)) {
      const at = dy + sum(heights.slice(i, from)) - sum(heights.slice(from, i)) - groupAbove(heights, group, from) + groupAbove(heights, group, i);
      return { transform: `translateY(${at}px)`, zIndex: i === from ? 2 : 1, transition: 'none' };
    }
    const s = slotShifts(heights, group, drag.to)[i];
    return s ? { transform: `translateY(${s}px)` } : undefined;
  };
  /** The move the drag would make (R1.7: the chips show where they'd end), null while none. */
  const preview = drag ? { oids: drag.oids, to: drag.to } : null;
  /** The pressed row's drag badge: how many rows it carries (null: one, or not that row). */
  const count = (i: number): number | null => (drag && drag.from === i && drag.group.length > 1 ? drag.group.length : null);
  return { onPointerDown, style, dragging: drag !== null, preview, count };
}
