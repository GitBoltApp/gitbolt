import { ChevronRight } from 'lucide-react';
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { runFromMenu } from '../ui/arm/origin';
import { confirmable, confirmableKey, confirmArmed, consumeDisarmClick, disarm, isArmedOrigin, useArm } from '../ui/arm/store';
import { registerKeys } from '../ui/keyRouter';
import { hideTooltip, showTooltip } from '../ui/tooltipStore';
import { pressedAnchor, runMenuRowHook, useMenu } from './menuStore';
import { placeMenu, placeSubmenu } from './position';
import type { MenuRow, Variant } from './types';
import './menu.css';

declare global {
  interface Window { __gbMenuLatency?: number }
}

type Action = Extract<MenuRow, { kind: 'action' }>;
type Submenu = Extract<MenuRow, { kind: 'submenu' }>;
type Anchor = { left: number; right: number; top: number };
/** One open level: the root menu, then each open submenu (`anchor`: its row's box; `parent`:
 * that row's index in the level above). */
interface Level { rows: MenuRow[]; active: number; variant: number; left: number; top: number; anchor?: Anchor; parent?: number }

const ROW_H = 26;
const PAD = 8;
const SUB_W = 220;
/** Submenus open at once, on the same pointerenter/pointermove that reaches their row: no
 * hover-intent timer (K29). The safe triangle below is for switching away from an open submenu,
 * never for the first open. */
/** Hover intent, the safe triangle: leaving a submenu's row, the pointer may cross the rows of
 * the parent level (a diagonal move into the submenu) while it stays inside the triangle from
 * where it left to the submenu's near edge. Resting that long inside it (no move) hands over to
 * the row under the pointer; leaving the triangle does so at once. */
export const SUBMENU_GRACE_MS = 300;
/** A window blur closes the menu only once the window has stayed unfocused this long (K24).
 * Under GNOME (mutter on Xwayland) every button press in the window refocuses it: the window
 * manager's `WM_TAKE_FOCUS`, which the CEF runtime answers by moving the X focus back to the
 * browser (vendor/tauri-runtime-cef/GITBOLT-PATCH.md). The page sees that as a window blur and,
 * a few ms later, a focus, right after the right-click that opened the menu. Closing on the blur
 * itself closed every menu at once. A real deactivation (another window) has no focus after it. */
export const BLUR_SETTLE_MS = 150;

type Pt = { x: number; y: number };
const cross = (o: Pt, a: Pt, b: Pt) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
/** Whether `p` lies inside triangle `t` (either winding, edges included). */
export function inTriangle(p: Pt, t: readonly [Pt, Pt, Pt]): boolean {
  const d1 = cross(t[0], t[1], p);
  const d2 = cross(t[1], t[2], p);
  const d3 = cross(t[2], t[0], p);
  return !((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0));
}

const idOf = (r: MenuRow | undefined) => (r && r.kind !== 'separator' ? r.id : null);
const enabled = (r: MenuRow | undefined) => !!r && r.kind !== 'separator' && !(r.kind === 'action' && r.disabledReason);
const firstEnabled = (rows: MenuRow[]) => Math.max(0, rows.findIndex(enabled));
const startIndex = (rows: MenuRow[], initial?: string) => {
  const i = initial ? rows.findIndex((r) => idOf(r) === initial) : -1;
  return i >= 0 && enabled(rows[i]) ? i : firstEnabled(rows);
};
function step(rows: MenuRow[], from: number, dir: 1 | -1): number {
  for (let i = 1; i <= rows.length; i++) {
    const j = (from + dir * i + rows.length) % rows.length;
    if (enabled(rows[j])) return j;
  }
  return from;
}
const variantsOf = (r: MenuRow | undefined): Variant[] => (r?.kind === 'action' ? r.variants ?? [] : []);
const tipOf = (r: Exclude<MenuRow, { kind: 'separator' }>) => (r.kind === 'action' && r.disabledReason) || r.tooltip;
const viewport = () => ({ w: window.innerWidth, h: window.innerHeight });
/** A first guess at a submenu's box; corrected from its measured size before paint. */
const subPlace = (anchor: Anchor, rows: MenuRow[]) => placeSubmenu(anchor, { w: SUB_W, h: rows.length * ROW_H + PAD }, viewport());

/** The levels for refreshed `rows`: each level keeps its active row (by id; a submenu whose
 * row is gone, e.g. "Looking for editors…", starts on its `initial` row again) and each open
 * submenu stays open while its row is still a submenu. */
export function remap(old: Level[], rows: MenuRow[]): Level[] {
  const out: Level[] = [];
  let cur = rows;
  let initial: string | undefined;
  for (let d = 0; d < old.length; d++) {
    const o = old[d];
    const id = idOf(o.rows[o.active]);
    const found = cur.findIndex((r) => idOf(r) === id);
    const active = found >= 0 && (enabled(cur[found]) || cur[found].kind === 'submenu') ? found : startIndex(cur, initial);
    const place = d > 0 && o.anchor ? subPlace(o.anchor, cur) : { left: o.left, top: o.top };
    const variant = active === found && variantsOf(cur[active])[o.variant] ? o.variant : -1;
    out.push({ ...o, ...place, rows: cur, active, variant, parent: d > 0 ? out[d - 1].active : undefined });
    const sub = cur[active];
    if (!old[d + 1] || sub?.kind !== 'submenu' || idOf(sub) !== id) break;
    cur = sub.rows;
    initial = sub.initial;
  }
  return out;
}

/**
 * Spec §7: the one menu element, always in the page, filled and positioned on open (at the
 * pointer, flipped at the screen edges).
 * - Submenus open on →, Enter, a click, or a hover — all at once, synchronously, positioned
 *   before paint (K29). The safe triangle (SUBMENU_GRACE_MS) only delays switching away from an
 *   already-open submenu, never the first open.
 * - Every row and variant shows its tooltip at once (`disabledReason` wins). A submenu row's
 *   own tooltip goes away while its submenu is open (it would cover it).
 * - Keys, taken at the window while the menu is open so no app shortcut (F7, Shift+↑/↓, Esc…)
 *   acts behind it: ↑/↓/Home/End move between rows (wrapping, skipping separators and
 *   disabled rows), ←/→ between variants and in and out of submenus, Enter/Space runs, Esc
 *   closes (a submenu first), Tab closes.
 * - Escape, Tab and a pick give focus back to where it was; a press outside closes it and leaves
 *   focus alone (the press already moved it). A resize or the window losing focus for good (I2;
 *   `BLUR_SETTLE_MS`, K24) also give focus back, when it's still on the menu itself: those don't
 *   move focus on their own, so without it the browser would drop it to `<body>` when the menu
 *   hides or unmounts.
 * - A scroll doesn't close it (K1), and the wheel outside it is swallowed while it's open, as
 *   under a native menu: nothing behind it moves.
 * - Records `window.__gbMenuLatency` (spec §17.3).
 */
export function ContextMenu() {
  const rows = useMenu((s) => s.rows);
  const seq = useMenu((s) => s.seq);
  const x = useMenu((s) => s.x);
  const y = useMenu((s) => s.y);
  const initialRow = useMenu((s) => s.initialRow);
  const label = useMenu((s) => s.label);
  const armed = useArm((s) => (s.armed?.mode === 'inline' ? s.armed : null));
  const uid = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const [levels, setLevels] = useState<Level[]>([]);
  const placedSeq = useRef(-1);
  const returnTo = useRef<HTMLElement | null>(null);
  // The safe triangle while the pointer heads for the open submenu below level `depth`, and
  // what to do once it's over (`pending`: the row the pointer crossed onto meanwhile).
  const grace = useRef<{ depth: number; tri: [Pt, Pt, Pt]; timer?: ReturnType<typeof setTimeout>; pending: (() => void) | null } | null>(null);
  const endGrace = (apply: boolean) => {
    const g = grace.current;
    if (!g) return;
    clearTimeout(g.timer);
    grace.current = null;
    if (apply) g.pending?.();
  };
  const armGrace = () => {
    const g = grace.current;
    if (!g) return;
    clearTimeout(g.timer);
    g.timer = setTimeout(() => endGrace(true), SUBMENU_GRACE_MS);
  };

  useLayoutEffect(() => {
    const el = rootRef.current;
    if (!rows || !el) {
      placedSeq.current = -1;
      setLevels([]);
      return;
    }
    if (placedSeq.current === seq) {
      setLevels((ls) => remap(ls, rows));
      return;
    }
    placedSeq.current = seq;
    const focused = document.activeElement;
    if (!(focused instanceof HTMLElement && el.contains(focused))) returnTo.current = focused instanceof HTMLElement ? focused : null;
    const anchor = useMenu.getState().anchor;
    const { left, top } = placeMenu(x, y, { w: el.offsetWidth, h: el.offsetHeight }, viewport(), anchor?.isConnected ? anchor.getBoundingClientRect() : null);
    setLevels([{ rows, active: startIndex(rows, initialRow ?? undefined), variant: -1, left, top }]);
    el.focus({ preventScroll: true });
    window.__gbMenuLatency = performance.now() - useMenu.getState().openedAt;
  }, [rows, seq, x, y, initialRow]);

  // Submenus: placed from their measured size (the first guess assumed plain rows).
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    levels.forEach((lv, d) => {
      const el = d > 0 && lv.anchor ? root.querySelector<HTMLElement>(`[data-depth="${d}"]`) : null;
      const r = el?.getBoundingClientRect();
      if (!el || !r?.width) return;
      const p = placeSubmenu(lv.anchor!, { w: r.width, h: r.height }, viewport());
      el.style.left = `${p.left}px`;
      el.style.top = `${p.top}px`;
    });
  }, [levels]);

  // An armed row's label grows past the menu's edge: its tooltip would sit under it.
  useEffect(() => { if (armed) hideTooltip(); }, [armed]);

  // An armed row disarms once its menu closes or another opens (spec §ui confirms).
  // Its rows rebuilt (a refresh: what the row would act on may have changed) disarm it too.
  useEffect(() => () => { if (useArm.getState().armed?.mode === 'inline') disarm(); }, [seq, rows]);

  // The latest key handler, for the window listener below.
  const keyHandler = useRef<(e: KeyboardEvent) => void>(() => {});

  const open = rows !== null;
  useEffect(() => {
    if (!open) return;
    const inside = (t: EventTarget | null) => t instanceof Node && !!rootRef.current?.contains(t);
    // I2: a resize or the window losing focus doesn't itself move focus, unlike a press (which
    // focuses whatever it hit) — so restore it, but only when it's still on the menu (not, say, a
    // pick's own focus move already in flight).
    const stillFocused = () => !!rootRef.current && rootRef.current.contains(document.activeElement);
    const onDown = (e: PointerEvent) => { if (!inside(e.target)) { pressedAnchor(e.target); dismiss(false); } };
    const onAway = () => dismiss(stillFocused());
    // K24: a window blur closes it only if the window stays unfocused (BLUR_SETTLE_MS): a press
    // under GNOME's window manager bounces the window focus (blur, then focus a few ms later).
    let blurTimer: ReturnType<typeof setTimeout> | undefined;
    const onBlur = () => {
      clearTimeout(blurTimer);
      blurTimer = setTimeout(onAway, BLUR_SETTLE_MS);
    };
    const onFocus = () => clearTimeout(blurTimer);
    // K1: a scroll doesn't close it. The browser dispatches scroll events in the frame after the
    // scroll, so one the user started before the right-click (a wheel notch, the tail of a smooth
    // or kinetic scroll) landed after the menu opened and closed it at once. As a native menu, the
    // wheel outside it moves nothing behind it (nor zooms an image) while it's open.
    const onWheel = (e: WheelEvent) => {
      if (inside(e.target)) return;
      e.preventDefault();
      e.stopPropagation();
    };
    // The safe triangle: moving inside it keeps the submenu (and restarts the rest timer);
    // leaving it hands over to the row the pointer is on.
    const onMove = (e: PointerEvent) => {
      const g = grace.current;
      if (!g) return;
      if (inTriangle({ x: e.clientX, y: e.clientY }, g.tri)) armGrace();
      else endGrace(true);
    };
    // Every key goes to the menu while it's open, wherever focus is: nothing behind it acts. It's
    // the key router's first layer (`ui/keyRouter.ts`), ahead of tooltips, editor overlays and
    // the app's keys (Esc, F7, Shift+↑↓), whichever registered first. Zoom (Ctrl+=/-/0, H2) is the
    // one exception: the router routes it past this layer so it still works while the menu is open.
    const offKeys = registerKeys('menu', (e) => {
      keyHandler.current(e);
      if (!e.ctrlKey && !e.metaKey) e.preventDefault();
      return 'handled';
    });
    window.addEventListener('pointerdown', onDown, true);
    window.addEventListener('wheel', onWheel, { capture: true, passive: false });
    window.addEventListener('blur', onBlur);
    window.addEventListener('focus', onFocus);
    window.addEventListener('resize', onAway);
    window.addEventListener('pointermove', onMove, true);
    return () => {
      window.removeEventListener('pointermove', onMove, true);
      endGrace(false);
      window.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('wheel', onWheel, true);
      clearTimeout(blurTimer);
      window.removeEventListener('blur', onBlur);
      window.removeEventListener('focus', onFocus);
      window.removeEventListener('resize', onAway);
      offKeys();
    };
  }, [open]);

  function dismiss(restore: boolean) {
    if (useArm.getState().armed?.mode === 'inline') disarm();
    endGrace(false);
    hideTooltip();
    const back = returnTo.current;
    returnTo.current = null;
    if (restore && back?.isConnected) back.focus({ preventScroll: true });
    useMenu.getState().close();
  }
  /**
   * Runs a pick with its row as the origin (spec §ui confirms): an action that asks arms the row
   * in place and the menu stays open (board A); the armed row's own second pick confirms it.
   * Otherwise the menu closes after the pick's synchronous part, as before (or once a held
   * origin is released: an integrate's preview).
   */
  type Pick = MouseEvent | KeyboardEvent;
  const viaOf = (ev: Pick): 'pointer' | 'key' => (ev instanceof KeyboardEvent || ev.detail === 0 ? 'key' : 'pointer');
  const pick = (el: HTMLElement | null, ev: Pick, id: string, label: string, run: () => void) => {
    const via = viaOf(ev);
    const a = useArm.getState().armed;
    if (a?.mode === 'inline' && el && a.origin?.el === el) {
      // A fresh pick after the settle confirms; a double click's second or a repeat doesn't.
      if (ev instanceof KeyboardEvent ? confirmableKey(ev, a) : confirmable(ev, a)) confirmArmed();
      return;
    }
    if (!el) {
      dismiss(true);
      runMenuRowHook(id, label, run);
      return;
    }
    // Focus is back before the action runs, so an action that moves focus wins; an armed row
    // keeps its menu open meanwhile (the menu takes every key wherever focus is).
    const back = returnTo.current;
    if (back?.isConnected) back.focus({ preventScroll: true });
    const mine = useMenu.getState().seq;
    const close = () => {
      const m = useMenu.getState();
      if (m.seq === mine && m.rows) dismiss(false);
    };
    runFromMenu(el, via, close, () => runMenuRowHook(id, label, run), isArmedOrigin);
  };
  // Through the row-run hook (R11): the action log records each row run.
  const runRow = (r: Action, el: HTMLElement | null, ev: Pick) => { if (!r.disabledReason) pick(el, ev, r.id, r.label, r.run); };
  const runVariant = (r: Action, v: Variant, el: HTMLElement | null, ev: Pick) => { if (!v.disabledReason) pick(el, ev, v.id, `${r.label}: ${v.label ?? v.tooltip}`, v.run); };

  const rowId = (depth: number, index: number) => `${uid}-${depth}-${index}`;
  const levelId = (depth: number) => `${uid}-level-${depth}`;
  const rowEl = (depth: number, index: number) => (typeof document === 'undefined' ? null : document.getElementById(rowId(depth, index)));
  const subOpenAt = (depth: number, index: number) => levels[depth + 1]?.parent === index;
  // A row's tooltip sits beside the menu, on the side away from its parent level (a submenu
  // flipped to the left gets its tooltips on the left), never over the rows or the parent.
  const tipRow = (el: Element, r: Exclude<MenuRow, { kind: 'separator' }>) => {
    // An armed row's label covers the menu's side: no tooltip while one is armed.
    if (useArm.getState().armed?.mode === 'inline') return;
    const depth = Number(el.closest<HTMLElement>('.ctx-level')?.dataset.depth ?? 0);
    const lv = levels[depth];
    const leftward = !!lv?.anchor && lv.left < lv.anchor.left;
    showTooltip(el, tipOf(r), 0, leftward ? 'left' : 'right');
  };
  const tipVariant = (el: Element, v: Variant) => { if (useArm.getState().armed?.mode !== 'inline') showTooltip(el, v.disabledReason || v.tooltip); };

  /** Opens the submenu of row `index` at `depth` now (kept as it is if it's already open). Its
   * row's tooltip goes: it would cover the submenu. */
  const openSub = (depth: number, index: number, anchor: HTMLElement) => {
    hideTooltip();
    setLevels((ls) => {
      const r = ls[depth]?.rows[index];
      if (r?.kind !== 'submenu') return ls;
      const here = ls.slice(0, depth + 1).map((l, i) => (i === depth ? { ...l, active: index, variant: -1 } : l));
      if (ls[depth + 1]?.parent === index && ls[depth + 1].rows === r.rows) return [...here, ...ls.slice(depth + 1, depth + 2)];
      const rect = anchor.getBoundingClientRect();
      const a = { left: rect.left, right: rect.right, top: rect.top };
      return [...here, { rows: r.rows, active: startIndex(r.rows, r.initial), variant: -1, ...subPlace(a, r.rows), anchor: a, parent: index }];
    });
  };

  const onRowEnterNow = (depth: number, i: number, r: Exclude<MenuRow, { kind: 'separator' }>, el: HTMLElement) => {
    setLevels((ls) => ls.map((l, k) => (k === depth ? { ...l, active: i, variant: -1 } : l)));
    if (r.kind === 'submenu') {
      if (subOpenAt(depth, i)) {
        // Back on the open submenu's own row: keep it; no tooltip over it.
        hideTooltip();
        return;
      }
      tipRow(el, r);
      openSub(depth, i, el);
      return;
    }
    tipRow(el, r);
    if (levels.length > depth + 1) setLevels((ls) => ls.slice(0, depth + 1));
  };

  const onRowEnter = (depth: number, i: number, r: Exclude<MenuRow, { kind: 'separator' }>, e: { clientX: number; clientY: number; currentTarget: HTMLElement }) => {
    const el = e.currentTarget;
    const g = grace.current;
    // Crossing this level's rows on the way into the submenu: nothing changes yet.
    if (g && g.depth === depth && inTriangle({ x: e.clientX, y: e.clientY }, g.tri)) {
      g.pending = () => onRowEnterNow(depth, i, r, el);
      armGrace();
      return;
    }
    endGrace(false);
    onRowEnterNow(depth, i, r, el);
  };

  /** The pointer leaves the row of an open submenu: the safe triangle, from where it left to
   * the submenu's near edge. */
  const onRowLeave = (depth: number, e: { clientX: number; clientY: number }) => {
    const sub = rootRef.current?.querySelector<HTMLElement>(`[data-depth="${depth + 1}"]`);
    const r = sub?.getBoundingClientRect();
    if (!r || !r.width) return;
    const toRight = r.left >= e.clientX;
    const edge = toRight ? r.left : r.right;
    // The apex a little behind the exit point, so a move straight across the edge counts.
    const apex = { x: e.clientX + (toRight ? -4 : 4), y: e.clientY };
    grace.current = { depth, tri: [apex, { x: edge, y: r.top - 4 }, { x: edge, y: r.bottom + 4 }], pending: null };
    armGrace();
  };

  /** The pointer reached submenu level `depth`: it stays open, its row active again. */
  const onLevelEnter = (depth: number) => {
    if (depth === 0) return;
    endGrace(false);
    setLevels((ls) => ls.slice(0, depth + 1).map((l, k) => (k === depth - 1 && ls[depth]?.parent !== undefined ? { ...l, active: ls[depth].parent!, variant: -1 } : l)));
  };

  const onKeyDown = (e: KeyboardEvent) => {
    const depth = levels.length - 1;
    const lv = levels[depth];
    if (!lv) return;
    const row = lv.rows[lv.active];
    const set = (patch: Partial<Level>) => setLevels((ls) => ls.map((l, i) => (i === depth ? { ...l, ...patch } : l)));
    const moveTo = (active: number) => {
      if (armed) disarm();
      set({ active, variant: -1 });
      const r = lv.rows[active];
      const el = rowEl(depth, active);
      if (el && r && r.kind !== 'separator') tipRow(el, r);
    };
    const toVariant = (v: number) => {
      if (armed) disarm();
      set({ variant: v });
      const vs = variantsOf(row);
      const el = rowEl(depth, lv.active);
      if (v < 0) { if (el && row && row.kind !== 'separator') tipRow(el, row); return; }
      const button = el?.querySelectorAll('.ctx-variant')[v];
      if (button) tipVariant(button, vs[v]);
    };
    const closeSub = () => {
      hideTooltip();
      setLevels((ls) => ls.slice(0, -1));
    };
    switch (e.key) {
      case 'ArrowDown': moveTo(step(lv.rows, lv.active, 1)); break;
      case 'ArrowUp': moveTo(step(lv.rows, lv.active, -1)); break;
      case 'Home': moveTo(step(lv.rows, lv.rows.length - 1, 1)); break;
      case 'End': moveTo(step(lv.rows, 0, -1)); break;
      case 'ArrowRight': {
        if (row?.kind === 'submenu') {
          const el = rowEl(depth, lv.active);
          if (el) openSub(depth, lv.active, el);
        } else {
          const vs = variantsOf(row);
          let v = lv.variant + 1;
          while (v < vs.length && vs[v].disabledReason) v++;
          if (v < vs.length) toVariant(v);
        }
        break;
      }
      case 'ArrowLeft':
        if (lv.variant >= 0) {
          const vs = variantsOf(row);
          let v = lv.variant - 1;
          while (v >= 0 && vs[v].disabledReason) v--;
          toVariant(v);
        } else if (depth > 0) closeSub();
        break;
      case 'Enter':
      case ' ':
        // A held key's repeats pick nothing (they'd confirm a row the first press armed).
        if (e.repeat) break;
        if (row?.kind === 'submenu') {
          const el = rowEl(depth, lv.active);
          if (el) openSub(depth, lv.active, el);
        } else if (row?.kind === 'action') {
          const v = variantsOf(row)[lv.variant];
          if (v) runVariant(row, v, rowEl(depth, lv.active), e);
          else runRow(row, rowEl(depth, lv.active), e);
        }
        break;
      case 'Escape':
        // Esc disarms an armed row first; the menu stays.
        if (armed) disarm();
        else if (depth > 0) closeSub();
        else dismiss(true);
        break;
      case 'Tab': dismiss(true); break;
      default: return;
    }
  };
  keyHandler.current = onKeyDown;

  const renderLevel = (lv: Level, depth: number, parent: MenuRow | undefined) => (
    <div
      key={depth}
      id={depth ? levelId(depth) : undefined}
      className="ctx-level"
      data-depth={depth}
      role={depth ? 'menu' : undefined}
      aria-label={depth && parent && parent.kind !== 'separator' ? parent.label : undefined}
      style={depth ? { left: lv.left, top: lv.top } : undefined}
      onPointerEnter={() => onLevelEnter(depth)}
    >
      {lv.rows.map((r, i) => {
        if (r.kind === 'separator') return <div key={`sep${i}`} className="ctx-sep" role="separator" />;
        const Icon = r.icon;
        const active = i === lv.active;
        const disabled = r.kind === 'action' && !!r.disabledReason;
        const expanded = r.kind === 'submenu' && levels[depth + 1]?.parent === i;
        const armedHere = !!armed && armed.origin?.el.id === rowId(depth, i);
        return (
          <div
            key={r.id}
            id={rowId(depth, i)}
            role="menuitem"
            data-row-id={r.id}
            data-index={i}
            data-active={active}
            aria-disabled={disabled || undefined}
            aria-haspopup={r.kind === 'submenu' ? 'menu' : undefined}
            aria-expanded={r.kind === 'submenu' ? expanded : undefined}
            aria-owns={expanded ? levelId(depth + 1) : undefined}
            // Named by its label alone: the submenu it owns would otherwise join its name. Armed,
            // by what a second click does.
            aria-label={armedHere ? armed!.req.arm : r.kind === 'submenu' ? r.label : undefined}
            data-armed={armedHere ? armed!.req.tone : undefined}
            aria-description={tipOf(r)}
            className="ctx-row"
            onPointerEnter={(e) => onRowEnter(depth, i, r, e)}
            onPointerLeave={(e) => {
              if (r.kind === 'submenu' && expanded) onRowLeave(depth, e);
              else hideTooltip();
            }}
            onClick={(e) => {
              // A press on another row while one is armed only disarms it.
              if (consumeDisarmClick(e.target)) return;
              if (r.kind === 'action') runRow(r, e.currentTarget, e.nativeEvent);
              else openSub(depth, i, e.currentTarget);
            }}
          >
            <Icon size={14} className="ctx-icon" aria-hidden />
            <span className="ctx-label">{r.label}</span>
            {r.kind === 'action' && r.shortcut && <span className="ctx-shortcut">{r.shortcut}</span>}
            {r.kind === 'submenu' && <ChevronRight size={12} className="ctx-chevron" aria-hidden />}
            {r.kind === 'action' && r.variants && (
              <span className="ctx-variants">
                {r.variants.map((v, j) => {
                  const VIcon = v.icon;
                  return (
                    <button
                      key={v.id}
                      type="button"
                      tabIndex={-1}
                      className="ctx-variant"
                      data-variant-id={v.id}
                      aria-label={v.tooltip}
                      aria-disabled={!!v.disabledReason || undefined}
                      data-active={active && j === lv.variant}
                      onPointerEnter={(e) => { e.stopPropagation(); tipVariant(e.currentTarget, v); }}
                      onPointerLeave={(e) => {
                        e.stopPropagation();
                        // K25: moving straight into a sibling in this group leaves the tooltip alone —
                        // that sibling's own pointerEnter (above) swaps it to its tooltip directly. Only
                        // leaving the group altogether falls back to the row's tooltip, so the pointer
                        // never passes through it mid-group.
                        const next = e.relatedTarget;
                        if (next instanceof Element && next.classList.contains('ctx-variant') && next.parentElement === e.currentTarget.parentElement) return;
                        tipRow(e.currentTarget.closest('.ctx-row')!, r);
                      }}
                      onClick={(e) => {
                        e.stopPropagation();
                        if (consumeDisarmClick(e.target)) return;
                        runVariant(r, v, e.currentTarget.closest<HTMLElement>('.ctx-row'), e.nativeEvent);
                      }}
                    >
                      {VIcon ? <VIcon size={13} aria-hidden /> : v.label}
                    </button>
                  );
                })}
              </span>
            )}
            {/* Armed (board A): the row's own space, over its label and variants; a longer label
                grows past the menu's edge rather than widening it. */}
            {armedHere && (
              <span className={`ctx-armed-label tone-${armed!.req.tone}`} aria-hidden>
                <Icon size={14} className="ctx-icon" aria-hidden />
                {armed!.req.arm}
              </span>
            )}
          </div>
        );
      })}
    </div>
  );

  const shown = rows ? (levels.length ? levels : [{ rows, active: startIndex(rows, initialRow ?? undefined), variant: -1, left: x, top: y }]) : [];
  const deepest = shown.length - 1;
  const activeRow = shown[deepest]?.rows[shown[deepest].active];
  const root = levels[0];
  return (
    <div
      ref={rootRef}
      role="menu"
      aria-label={label ?? 'Context menu'}
      aria-activedescendant={activeRow && activeRow.kind !== 'separator' ? rowId(deepest, shown[deepest].active) : undefined}
      tabIndex={-1}
      className="ctx-menu"
      data-testid="context-menu"
      hidden={!rows}
      style={root ? { left: root.left, top: root.top } : { left: x, top: y }}
      onMouseDown={(e) => e.preventDefault()}
      onContextMenu={(e) => e.preventDefault()}
    >
      {shown.map((lv, d) => renderLevel(lv, d, d > 0 ? (shown[d - 1].rows[lv.parent ?? shown[d - 1].active] as Submenu | undefined) : undefined))}
    </div>
  );
}
