import { openTop, type ChangeBox } from './changeNav';
import { changeBox, changeTargets, STEP_MARGIN } from './changeStepper';
import type { DiffLine } from './monaco/host';
import { blockTop } from './review/renderedBlocks';

/** How long the open keeps its change in place after the content last relaid out. */
export const OPEN_HOLD_MS = 2000;
/** The longest the open waits for, and follows, the content (a large diff streams in chunks). */
export const OPEN_MAX_MS = 15_000;

/** Where a rendered diff opens (`openTop`, as the source diff): at the top when its first change
 * shows there whole, else that change centred, or a margin below its top when it's taller than
 * the pane. Null: no change has rendered. */
export function firstChangeTop(pane: HTMLElement): number | null {
  const origin = pane.getBoundingClientRect().top - pane.scrollTop;
  let first: ChangeBox | null = null;
  for (const el of changeTargets(pane)) {
    const r = changeBox(el);
    if (!first || r.top - origin < first.top) first = { top: r.top - origin, bottom: r.bottom - origin };
  }
  return first && openTop(first, pane.clientHeight, STEP_MARGIN);
}

/**
 * Holds `pane` at `where` (a scroll top; null: not rendered yet) once it can be placed, and
 * holds it there through late relayouts (images, diagrams, chunks laying out, a font zoom) as the
 * source diff's open does, until the content has been still for OPEN_HOLD_MS or the user scrolls.
 * The browser's own scroll anchoring is off meanwhile: any scroll but ours is the user's. Returns
 * its stop.
 */
function holdAt(pane: HTMLElement, where: (pane: HTMLElement) => number | null): () => void {
  let placed: number | null = null;
  let placing = false;
  let frame = 0;
  let hold = 0;
  const anchoring = pane.style.overflowAnchor;
  pane.style.overflowAnchor = 'none';
  const place = () => {
    frame = 0;
    const top = where(pane);
    if (top === null) return;
    placing = true;
    pane.scrollTop = top;
    placing = false;
    placed = pane.scrollTop;
    clearTimeout(hold);
    hold = window.setTimeout(stop, OPEN_HOLD_MS);
  };
  const schedule = () => { if (!frame) frame = requestAnimationFrame(place); };
  const onScroll = () => { if (!placing && placed !== null && Math.abs(pane.scrollTop - placed) > 1) stop(); };
  const ro = new ResizeObserver(schedule);
  const observe = () => { ro.disconnect(); ro.observe(pane); for (const k of pane.children) ro.observe(k); };
  const mo = new MutationObserver(() => { observe(); schedule(); });
  const deadline = window.setTimeout(() => stop(), OPEN_MAX_MS);
  function stop() {
    cancelAnimationFrame(frame);
    clearTimeout(hold);
    clearTimeout(deadline);
    ro.disconnect();
    mo.disconnect();
    pane.removeEventListener('scroll', onScroll);
    pane.removeEventListener('load', schedule, true);
    pane.style.overflowAnchor = anchoring;
  }
  observe();
  mo.observe(pane, { childList: true, subtree: true });
  pane.addEventListener('scroll', onScroll, { passive: true });
  // An image's load doesn't bubble: caught on its way down.
  pane.addEventListener('load', schedule, true);
  schedule();
  return stop;
}

/** Opens `pane`'s rendered diff at its first change (`firstChangeTop`), held through late
 * relayouts. Returns its stop. */
export const holdFirstChange = (pane: HTMLElement): (() => void) => holdAt(pane, firstChangeTop);

/** Review comments (spec 2026-10-08 §3): opens `pane`'s rendered diff at the block holding line
 * `at` (a note's `file:line`, a file badge's thread), held as the first change is: a block in a
 * chunk that renders later is waited for. Returns its stop. */
export const holdLine = (pane: HTMLElement, at: DiffLine): (() => void) => holdAt(pane, (p) => blockTop(p, at));
