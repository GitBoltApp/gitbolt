import { useEffect, useRef } from 'react';
import type { PlaceView } from './history';

/**
 * Scroll positions for navigation places (spec #5 §3.4): what a place was scrolled to when it
 * was left, and where a restore asks its view to scroll once it shows. Views report through
 * `useScrollPlace` (a DOM pane) or `registerScrollSource` (Monaco, read live).
 */
export type ScrollKind = 'mr' | 'file';
interface Source { key: string; get: () => number | null }

const sources = new Map<string, Source[]>();
const noted = new Map<string, number>();
/** The noted scrolls kept, oldest dropped first. */
export const NOTED_MAX = 500;
const slot = (tabId: string, kind: ScrollKind) => `${tabId}|${kind}`;

/** The last scroll position seen for place `key`. */
export function noteScroll(tabId: string, kind: ScrollKind, key: string, top: number): void {
  const k = `${slot(tabId, kind)}|${key}`;
  noted.delete(k);
  noted.set(k, top);
  if (noted.size > NOTED_MAX) noted.delete(noted.keys().next().value!);
}

/** A live reader of place `key`'s scroll; the newest of a tab and kind answers. Removing it
 * notes its last reading. `get` returns `null` while it can't tell (hidden). */
export function registerScrollSource(tabId: string, kind: ScrollKind, key: string, get: () => number | null): () => void {
  const s = slot(tabId, kind);
  const me: Source = { key, get };
  sources.set(s, [...(sources.get(s) ?? []), me]);
  return () => {
    const last = get();
    if (last !== null) noteScroll(tabId, kind, key, last);
    const rest = (sources.get(s) ?? []).filter((x) => x !== me);
    if (rest.length) sources.set(s, rest);
    else sources.delete(s);
  };
}

/** Place `key`'s scroll: its live source's reading, else the last noted one. */
export function scrollOf(tabId: string, kind: ScrollKind, key: string): number | null {
  const list = sources.get(slot(tabId, kind));
  const top = list?.[list.length - 1];
  const live = top && top.key === key ? top.get() : null;
  return live ?? noted.get(`${slot(tabId, kind)}|${key}`) ?? null;
}

/** Where a restored place's view scrolls once shown: `top`, or the heading `anchor`. `view`:
 * File View's view it's for (`null`: any). */
export interface PendingScroll { key: string; view: PlaceView | null; top: number; anchor: string | null }
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
  return { key: p.key, view: p.view, top: p.top, anchor: p.anchor };
}

/** How long a restore waits for its content to be tall enough (lazy chunks, idle parsing, images). */
export const SCROLL_WAIT_MS = 2000;
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

/** Scrolls the heading `anchor` (its `user-content-` id, as the renderer prefixes ids, or the
 * bare one) to the top of `el` once it has rendered; gives up after SCROLL_WAIT_MS. */
export function scrollToAnchorWhenReady(el: HTMLElement, anchor: string): () => void {
  const until = Date.now() + SCROLL_WAIT_MS;
  const ids = [`user-content-${anchor}`, anchor];
  let timer: ReturnType<typeof setTimeout> | undefined;
  const tick = () => {
    const hit = [...el.querySelectorAll<HTMLElement>('[id]')].find((n) => ids.includes(n.id));
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
 * in), it takes a restore's pending scroll for `view`.
 */
export function useScrollPlace(o: { tabId: string; kind: ScrollKind; key: string | null; el: () => HTMLElement | null; active: boolean; ready: boolean; view: PlaceView | null }): void {
  const el = useRef(o.el);
  el.current = o.el;
  const { tabId, kind, key, active, ready, view } = o;
  useEffect(() => {
    const target = el.current();
    if (!active || !key || !target) return;
    const shown = () => target.getClientRects().length > 0;
    const off = registerScrollSource(tabId, kind, key, () => (shown() ? target.scrollTop : null));
    const onScroll = () => noteScroll(tabId, kind, key, target.scrollTop);
    target.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      target.removeEventListener('scroll', onScroll);
      off();
    };
  }, [tabId, kind, key, active]);
  useEffect(() => {
    if (!active || !ready || !key) return;
    const target = el.current();
    const p = target ? takePendingScroll(tabId, kind, key, view) : null;
    if (!p || !target) return;
    return p.anchor ? scrollToAnchorWhenReady(target, p.anchor) : applyScrollWhenReady(target, p.top);
  }, [tabId, kind, key, active, ready, view]);
}
