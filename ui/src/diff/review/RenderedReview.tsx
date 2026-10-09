import { Plus } from 'lucide-react';
import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { sameJson } from '../../forge/mrStore';
import { shownItem, type PlacedItem } from '../../forge/review/model';
import { useReview, useReviewMrHead, useReviewPlacements } from '../../forge/review/session';
import { BlockSlotContext, type BlockSlots, type SrcSides } from '../../markdown/blockSlot';
import { useRepoView } from '../../repo/store';
import { registerKeyHints } from '../../shortcuts/hints';
import { useToast } from '../../ui/toastStore';
import { setBlockCommenter } from './blockComment';
import { reviewModeOf, type ReviewModeOf } from './mode';
import { blockedNote, NOT_COMMENTABLE } from './ReviewMode';
import { ReviewModeNote } from './ReviewNotes';
import { assignBoxes, assignItems, hoverBlock, keyboardTarget, scanBlocks, slotKey, sourceLines, type BlockTarget, type Place, type SrcBlock } from './renderedBlocks';
import { boxesOf, closeBox, openBox, useReviewUi, type OpenBox } from './store';
import './renderedReview.css';

/** The cards, loaded once a review shows (as the source diff's `ActiveReview`). */
const RenderedCards = lazy(() => import('./RenderedCards').then((m) => ({ default: m.RenderedCards })));

/** How far left of a block its "+" sits, in px: in the pane's padding, clear of the change bar. */
const PLUS_OFFSET = 26;
const NO_ITEMS: PlacedItem[] = [];

/** Review mode for the rendered diff of `path`: the source diff's (`reviewModeOf`). */
function useRenderedReviewMode(tabId: string, path: string): ReviewModeOf {
  const s = useReview(tabId);
  const sel = useRepoView((st) => st.selection);
  return reviewModeOf(s, sel, { path, view: 'diff' }, useReviewMrHead(tabId));
}

/** Over the rendered diff, as over the source diff (`ActiveReview`): review mode's note
 * (`ReviewModeNote`). Diff View shows it beside the pane,
 * in the frame, so it stays put as the pane scrolls. */
export function RenderedReviewNote({ tabId, path }: { tabId: string; path: string }) {
  const mode = useRenderedReviewMode(tabId, path);
  if (!mode.on) return null;
  return <ReviewModeNote tabId={tabId} mode={mode} />;
}

interface PlusAt { top: number; left: number; target: BlockTarget }

/**
 * The rendered Markdown diff in review mode (spec 2026-10-08 §3), around `MarkdownDiff` in Diff
 * View's `pane`. While the diff is the tab's review Compare: each block shows the threads and
 * drafts on its lines under it (the innermost block holding a thread's last line,
 * `assignItems`); a "+" left of a hovered block that touches the MR's diff opens a comment box
 * under it for the block's lines, clipped to the forge's (`blockTarget`), Suggest change
 * prefilled with their source; and the comment key does the same for the block holding the
 * selection, or the first one in view (`setBlockCommenter`). The blocks are read from the page
 * (`scanBlocks`), again as it changes: a streamed chunk, a card. Otherwise: `children` alone.
 */
export function RenderedReview({ tabId, path, pane, modified, children }: { tabId: string; path: string; pane: HTMLElement | null; modified: string; children: ReactNode }) {
  const mode = useRenderedReviewMode(tabId, path);
  const on = mode.on;
  const stale = mode.on && mode.stale;
  const file = mode.on && !mode.stale ? mode.file : null;
  const review = useReview(tabId);
  const number = review?.number ?? -1;
  const placed = useReviewPlacements(tabId);
  // As the source diff (`ActiveReview`): a stale Compare shows none of the forge's cards.
  const items = (on && !stale && placed?.byPath[path]) || NO_ITEMS;
  // The open boxes are the session's (`useReviewUi`), shared with the source diff: a box opened
  // in one view shows in the other, and outlives a file opened meanwhile or the Compare going stale.
  const allBoxes = useReviewUi((s) => boxesOf(s, tabId, number));
  const boxes = useMemo(() => allBoxes.filter((b) => b.anchor.path === path), [allBoxes, path]);
  const blocked = blockedNote(mode, review?.kind ?? 'gitlab', number);
  const [blocks, setBlocks] = useState<SrcBlock[]>([]);
  const [plus, setPlus] = useState<PlusAt | null>(null);
  useEffect(() => { setPlus(null); }, [path]);

  // The blocks' places in the pane's content (scroll-free), measured once as the pointer needs
  // them; dropped when the page changes or resizes. A move then reads the pane's place alone.
  const geometry = useRef<Map<HTMLElement, Place> | null>(null);
  useLayoutEffect(() => {
    if (!on || !pane) { setBlocks((cur) => (cur.length ? [] : cur)); return; }
    let frame = 0;
    const scan = () => { frame = 0; const next = scanBlocks(pane); setBlocks((cur) => (sameJson(cur, next) ? cur : next)); };
    // A change to the page moves the blocks: their measured places go too.
    const later = () => { geometry.current = null; if (!frame) frame = requestAnimationFrame(scan); };
    scan();
    // The rendered Markdown's root, not the pane: the "+" coming and going there is no change to
    // the blocks. The pane's own children are watched only for a new root.
    const inner = new MutationObserver(later);
    const resized = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => { geometry.current = null; });
    resized?.observe(pane);
    let root: Element | null = null;
    const attach = () => {
      const next = [...pane.children].find((c) => !c.classList.contains('md-block-plus')) ?? null;
      if (next === root) return false;
      if (root) resized?.unobserve(root);
      root = next;
      inner.disconnect();
      if (root) { inner.observe(root, { childList: true, subtree: true }); resized?.observe(root); }
      return true;
    };
    attach();
    const outer = new MutationObserver(() => { if (attach()) later(); });
    outer.observe(pane, { childList: true });
    return () => { inner.disconnect(); outer.disconnect(); resized?.disconnect(); cancelAnimationFrame(frame); geometry.current = null; };
  }, [on, pane]);

  // The box just opened: it takes the keyboard when it mounts (one laid out again doesn't).
  const [fresh, setFresh] = useState<string | null>(null);
  const openAt = useCallback((t: BlockTarget) => {
    setPlus(null);
    // A suggestion replaces the commented lines: only the new side has lines to replace.
    const suggestion = t.side === 'new' ? sourceLines(modified, t.from, t.to) : undefined;
    const key = openBox(tabId, number, t.anchor, suggestion);
    // Already open (here, or in the source diff): back to its text. It shows where its draft
    // will (`assignBoxes`).
    const open = [...(pane?.querySelectorAll<HTMLElement>('[data-box-key]') ?? [])].find((el) => el.dataset.boxKey === key);
    if (open) return open.querySelector('textarea')?.focus();
    setFresh(key);
  }, [modified, pane, tabId, number]);
  // Once it took the keyboard (or closed), a box is fresh no more: laid out again (a slot
  // remounting), it doesn't take it back.
  const settle = useCallback((key: string) => setFresh((cur) => (cur === key ? null : cur)), []);
  // A box sent or cancelled: the keyboard goes back to the diff, not to the page.
  const closed = useCallback((key: string) => {
    settle(key);
    closeBox(tabId, number, key);
    pane?.focus({ preventScroll: true });
  }, [pane, settle, tabId, number]);
  // An Esc no control in a card took (the cards own it: `repo/escape.ts`) leaves them for the
  // diff; the next one closes the file. As the source diff's cards (`ActiveReview`).
  const leaveOnEsc = useCallback((ev: KeyboardEvent) => {
    if (ev.key !== 'Escape' || ev.defaultPrevented || ev.ctrlKey || ev.altKey || ev.metaKey || ev.shiftKey) return;
    ev.preventDefault();
    pane?.focus({ preventScroll: true });
  }, [pane]);
  // A deleted draft held the keyboard: back to the diff.
  const leave = useCallback(() => pane?.focus({ preventScroll: true }), [pane]);

  useEffect(() => {
    if (!file || !pane) return;
    // Once a frame, at the pointer's latest place.
    let frame = 0;
    let last: { at: Element | null; x: number; y: number } | null = null;
    const hover = () => {
      frame = 0;
      if (!last) return;
      const { at, x, y } = last;
      if (at?.closest('.md-block-plus') && at.isConnected) return;
      const p = pane.getBoundingClientRect();
      const [ox, oy] = [p.left - pane.scrollLeft, p.top - pane.scrollTop];
      const places = (geometry.current ??= new Map());
      const rectOf = (el: HTMLElement): Place => {
        let c = places.get(el);
        if (!c) {
          const r = el.getBoundingClientRect();
          places.set(el, (c = { left: r.left - ox, top: r.top - oy, right: r.right - ox, bottom: r.bottom - oy }));
        }
        return { left: c.left + ox, top: c.top + oy, right: c.right + ox, bottom: c.bottom + oy };
      };
      const hit = hoverBlock(file, pane, at, x, y, rectOf);
      if (!hit) { setPlus(null); return; }
      const { el: block, target } = hit;
      const r = rectOf(block);
      setPlus((cur) => (cur?.target.key === target.key ? cur : { top: r.top - oy, left: Math.max(0, r.left - ox - PLUS_OFFSET), target }));
    };
    const onMove = (e: PointerEvent) => {
      last = { at: e.target instanceof Element ? e.target : null, x: e.clientX, y: e.clientY };
      if (!frame) frame = requestAnimationFrame(hover);
    };
    const onLeave = () => { cancelAnimationFrame(frame); frame = 0; last = null; setPlus(null); };
    pane.addEventListener('pointermove', onMove);
    pane.addEventListener('pointerleave', onLeave);
    return () => { pane.removeEventListener('pointermove', onMove); pane.removeEventListener('pointerleave', onLeave); cancelAnimationFrame(frame); setPlus(null); };
  }, [file, pane]);

  useEffect(() => {
    if (!file || !pane) return;
    // Nothing in view takes a comment: say so, as the source diff does.
    return setBlockCommenter(() => { const t = keyboardTarget(file, pane); if (t) openAt(t); else useToast.getState().show(NOT_COMMENTABLE); });
  }, [file, pane, openAt]);

  const assigned = useMemo(() => assignItems(blocks, items), [blocks, items]);
  const boxAt = useMemo(() => assignBoxes(blocks, boxes), [blocks, boxes]);
  const slots = useMemo<BlockSlots | null>(() => (on ? {
    render: (id: number, sides: SrcSides) => {
      const keys = (['new', 'old'] as const).filter((s) => sides[s]).map((s) => slotKey(id, s));
      // As the source diff (`reviewEntries`): a thread of system notes alone shows no card.
      const here = keys.flatMap((k) => assigned.get(k) ?? []).filter(shownItem);
      const open = keys.flatMap((k): OpenBox[] => boxAt.get(k) ?? []);
      if (here.length === 0 && open.length === 0) return null;
      return (
        <div className="review-card-keys" data-owns-escape="" onKeyDown={leaveOnEsc}>
          <Suspense fallback={null}><RenderedCards tabId={tabId} items={here} boxes={open} fresh={fresh} disabledReason={blocked} onClose={closed} onFocus={settle} onLeave={leave} /></Suspense>
        </div>
      );
    },
  } : null), [on, assigned, boxAt, tabId, closed, leaveOnEsc, leave, fresh, settle, blocked]);

  return (
    <>
      <BlockSlotContext value={slots}>{children}</BlockSlotContext>
      {plus && (
        <button type="button" className="md-block-plus" style={{ top: plus.top, left: plus.left }} aria-label={plus.target.label} onClick={() => openAt(plus.target)}>
          <Plus size={14} aria-hidden />
        </button>
      )}
    </>
  );
}

// Shown in the Keyboard Shortcuts panel (Ctrl+/); metadata only.
registerKeyHints([
  { id: 'key.renderedReviewCardLeave', section: 'Merge request', label: 'Leave the comment card for the rendered diff', keys: ['Esc'], context: '(on a comment card in the rendered Markdown diff)', source: 'diff/review/RenderedReview.tsx' },
]);
