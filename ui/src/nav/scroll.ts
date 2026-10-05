import { useEffect, useRef } from 'react';
import type { BlockPos, PlaceView } from './history';

/**
 * Scroll positions for navigation places (spec #5 §3.4): what a place was scrolled to when it
 * was left, and where a restore asks its view to scroll once it shows. Views report through
 * `useScrollPlace` (a DOM pane) or `registerScrollSource` (Monaco, read live). A long rendered
 * Markdown document also reports its first visible block (`BlockPos`): its chunks not rendered
 * yet have estimated heights, so a `scrollTop` alone would land elsewhere.
 */
export type ScrollKind = 'mr' | 'file';
interface Source { key: string; get: () => number | null; block?: () => BlockPos | null }

const sources = new Map<string, Source[]>();
const noted = new Map<string, number>();
const notedBlocks = new Map<string, BlockPos | null>();
/** The noted scrolls kept, oldest dropped first. */
export const NOTED_MAX = 500;
const slot = (tabId: string, kind: ScrollKind) => `${tabId}|${kind}`;

function keepNoted<V>(map: Map<string, V>, k: string, v: V): void {
  map.delete(k);
  map.set(k, v);
  if (map.size > NOTED_MAX) map.delete(map.keys().next().value!);
}

/** The last scroll position seen for place `key`. */
export function noteScroll(tabId: string, kind: ScrollKind, key: string, top: number): void {
  keepNoted(noted, `${slot(tabId, kind)}|${key}`, top);
}

/** A live reader of place `key`'s scroll; the newest of a tab and kind answers. Removing it
 * notes its last reading. `get` returns `null` while it can't tell (hidden). `block`: the first
 * visible block of a long Markdown document, read the same way. */
export function registerScrollSource(tabId: string, kind: ScrollKind, key: string, get: () => number | null, block?: () => BlockPos | null): () => void {
  const s = slot(tabId, kind);
  const me: Source = { key, get, block };
  sources.set(s, [...(sources.get(s) ?? []), me]);
  return () => {
    const last = get();
    if (last !== null) {
      noteScroll(tabId, kind, key, last);
      // The block goes with this reading: a source without blocks leaves none.
      if (block) keepNoted(notedBlocks, `${s}|${key}`, block());
      else notedBlocks.delete(`${s}|${key}`);
    }
    const rest = (sources.get(s) ?? []).filter((x) => x !== me);
    if (rest.length) sources.set(s, rest);
    else sources.delete(s);
  };
}

const liveSource = (tabId: string, kind: ScrollKind, key: string): Source | null => {
  const list = sources.get(slot(tabId, kind));
  const top = list?.[list.length - 1];
  return top && top.key === key ? top : null;
};

/** Place `key`'s scroll: its live source's reading, else the last noted one. */
export function scrollOf(tabId: string, kind: ScrollKind, key: string): number | null {
  return liveSource(tabId, kind, key)?.get() ?? noted.get(`${slot(tabId, kind)}|${key}`) ?? null;
}

/** Place `key`'s first visible block (a long Markdown document): read live, else the one noted
 * when its view went; `null` for a short document or a view that doesn't tell. */
export function scrollBlockOf(tabId: string, kind: ScrollKind, key: string): BlockPos | null {
  const live = liveSource(tabId, kind, key);
  // A shown source answers for itself (File View's Source has no blocks).
  if (live && live.get() !== null) return live.block?.() ?? null;
  return notedBlocks.get(`${slot(tabId, kind)}|${key}`) ?? null;
}

/** Where a restored place's view scrolls once shown: `top`, the heading `anchor`, or (a long
 * Markdown document) `block`. `view`: File View's view it's for (`null`: any). */
export interface PendingScroll { key: string; view: PlaceView | null; top: number; anchor: string | null; block?: BlockPos | null }
/** A pending scroll no view took within this long is dropped. */
export const PENDING_MS = 5000;
const pending = new Map<string, PendingScroll & { at: number }>();

export function setPendingScroll(tabId: string, kind: ScrollKind, p: PendingScroll): void {
  pending.set(slot(tabId, kind), { ...p, at: Date.now() });
}

/** The pending scroll for place `key` in `view`, once: a view takes it when it shows the place. */
export function takePendingScroll(tabId: string, kind: ScrollKind, key: string, view: PlaceView | null): PendingScroll | null {
  const k = slot(tabId, kind);
  const p = pending.get(k);
  if (!p || p.key !== key || (p.view !== null && view !== null && p.view !== view)) return null;
  pending.delete(k);
  if (Date.now() - p.at > PENDING_MS) return null;
  return { key: p.key, view: p.view, top: p.top, anchor: p.anchor, block: p.block ?? undefined };
}

/** How long a restore waits for its content to be tall enough (lazy chunks, idle parsing, images). */
export const SCROLL_WAIT_MS = 2000;
/** How long a block restore waits for its chunk: a long document renders one chunk per idle callback. */
export const BLOCK_WAIT_MS = 6000;
const POLL_MS = 16;

/** Scrolls `el` to `top` once its content is tall enough, or as far as it goes after
 * SCROLL_WAIT_MS. Returns its cancel. */
export function applyScrollWhenReady(el: HTMLElement, top: number): () => void {
  const until = Date.now() + SCROLL_WAIT_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const tick = () => {
    const room = el.scrollHeight - el.clientHeight;
    if (room >= top || Date.now() >= until) {
      el.scrollTop = Math.min(top, Math.max(0, room));
      return;
    }
    timer = setTimeout(tick, POLL_MS);
  };
  tick();
  return () => clearTimeout(timer);
}

/** The top-level blocks of the long (chunked) Markdown documents in `el`, in order; empty for a
 * short document (rendered whole: its `scrollTop` is exact). */
export const markdownBlocks = (el: HTMLElement): HTMLElement[] => [...el.querySelectorAll<HTMLElement>('.md > .md-chunk > *')];

/** `el`'s first visible block of a long Markdown document, and how far past its top `el` is
 * scrolled; `null` for a short one. A binary search: a few layout reads, however long. */
export function blockPosOf(el: HTMLElement): BlockPos | null {
  const blocks = markdownBlocks(el);
  if (blocks.length === 0) return null;
  const top = el.getBoundingClientRect().top;
  let lo = 0;
  let hi = blocks.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (blocks[mid]!.getBoundingClientRect().bottom <= top) lo = mid + 1;
    else hi = mid;
  }
  return { block: lo, offset: Math.max(0, Math.round(top - blocks[lo]!.getBoundingClientRect().top)) };
}

/** Scrolls block `pos.block` of `el`'s long Markdown document to its top (less `pos.offset`) once
 * its chunk has rendered, then once more after layout settles; `fallbackTop` when the block never
 * comes, or for a short document. A wheel, a key or a press in `el` stops it. Returns its cancel. */
export function scrollToBlockWhenReady(el: HTMLElement, pos: BlockPos, fallbackTop: number): () => void {
  const until = Date.now() + BLOCK_WAIT_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cancelFallback = () => {};
  let passes = 0;
  const stop = () => {
    clearTimeout(timer);
    cancelFallback();
    for (const e of ['wheel', 'keydown', 'pointerdown'] as const) el.removeEventListener(e, stop);
  };
  for (const e of ['wheel', 'keydown', 'pointerdown'] as const) el.addEventListener(e, stop, { passive: true });
  const tick = () => {
    const blocks = markdownBlocks(el);
    const target = blocks[pos.block];
    if (!target) {
      // A short document, or the block's chunk never came: the plain scroll.
      if (blocks.length === 0 || Date.now() >= until) {
        stop();
        cancelFallback = applyScrollWhenReady(el, fallbackTop);
        return;
      }
      timer = setTimeout(tick, POLL_MS);
      return;
    }
    const delta = target.getBoundingClientRect().top - el.getBoundingClientRect().top + pos.offset;
    if (Math.abs(delta) >= 1) el.scrollTop += delta;
    // Laying the block's chunk out can move it: check again until it holds (a few passes).
    if (++passes < 3 && Math.abs(delta) >= 1) timer = setTimeout(tick, POLL_MS);
    else stop();
  };
  tick();
  return stop;
}

/** Scrolls the heading `anchor` (its `user-content-` id, as the renderer prefixes ids, or the
 * bare one; an `<a name>` too) to the top of `el` once it has rendered; gives up after
 * SCROLL_WAIT_MS. `within`: where to look (one document among several), else all of `el`. */
export function scrollToAnchorWhenReady(el: HTMLElement, anchor: string, within: Element = el): () => void {
  const until = Date.now() + SCROLL_WAIT_MS;
  const ids = [`user-content-${anchor}`, anchor];
  let timer: ReturnType<typeof setTimeout> | undefined;
  const tick = () => {
    const hit = [...within.querySelectorAll<HTMLElement>('[id], a[name]')].find((n) => ids.includes(n.id) || (n.tagName === 'A' && ids.includes(n.getAttribute('name') ?? '')));
    if (hit) {
      el.scrollTop += hit.getBoundingClientRect().top - el.getBoundingClientRect().top;
      return;
    }
    if (Date.now() < until) timer = setTimeout(tick, POLL_MS);
  };
  tick();
  return () => clearTimeout(timer);
}

/**
 * A scrolling pane that shows place `key`: while `active`, it notes its scroll as it changes and
 * answers for it (not while hidden: a `display: none` pane reads 0); once `ready` (its content is
 * in), it takes a restore's pending scroll for `view`. `blocks`: the pane shows one Markdown
 * document, whose first visible block it reports and restores too (a long one).
 */
export function useScrollPlace(o: { tabId: string; kind: ScrollKind; key: string | null; el: () => HTMLElement | null; active: boolean; ready: boolean; view: PlaceView | null; blocks?: boolean }): void {
  const el = useRef(o.el);
  el.current = o.el;
  const { tabId, kind, key, active, ready, view, blocks = false } = o;
  useEffect(() => {
    const target = el.current();
    if (!active || !key || !target) return;
    const shown = () => target.getClientRects().length > 0;
    const off = registerScrollSource(tabId, kind, key, () => (shown() ? target.scrollTop : null), blocks ? () => blockPosOf(target) : undefined);
    const onScroll = () => noteScroll(tabId, kind, key, target.scrollTop);
    target.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      target.removeEventListener('scroll', onScroll);
      off();
    };
  }, [tabId, kind, key, active, blocks]);
  useEffect(() => {
    if (!active || !ready || !key) return;
    const target = el.current();
    const p = target ? takePendingScroll(tabId, kind, key, view) : null;
    if (!p || !target) return;
    if (p.anchor) return scrollToAnchorWhenReady(target, p.anchor);
    return blocks && p.block ? scrollToBlockWhenReady(target, p.block, p.top) : applyScrollWhenReady(target, p.top);
  }, [tabId, kind, key, active, ready, view, blocks]);
}
