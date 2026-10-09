import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { createPortal, flushSync } from 'react-dom';
import { useLend } from '../../app/lent';
import { anchorFor, anchorSpan, fromMonacoSide } from '../../forge/review/model';
import { useReview, useReviewPlacements } from '../../forge/review/session';
import { registerKeyHints } from '../../shortcuts/hints';
import { useToast } from '../../ui/toastStore';
import type { MonacoHost } from '../monaco/host';
import { useMonacoHost } from '../TextDiff';
import { CommentBox } from './CommentBox';
import { DraftCard } from './DraftCard';
import { lineSet, reviewEntries, type ReviewModeOf } from './mode';
import { blockedNote, NOT_COMMENTABLE } from './ReviewMode';
import { ReviewModeNote } from './ReviewNotes';
import { boxesOf, closeBox, openBox, useReviewUi } from './store';
import { ThreadCard } from './ThreadCard';
import './review.css';

const NO_NODES: ReadonlyMap<string, HTMLElement> = new Map();

/**
 * The gutter's "+" and Mod+Alt+C open a comment box under the lines; the MR's threads, the user's
 * drafts and the open boxes are cards under their lines (the host's view zones, rendered here
 * through portals); F9 / Shift+F9 step between threads and drafts. A stale Compare (the MR's head
 * moved) shows none of the forge's cards, only a banner to compare again.
 */
export function ActiveReview({ tabId, path, mode }: { tabId: string; path: string; mode: Extract<ReviewModeOf, { on: true }> }) {
  const { host } = useMonacoHost();
  const review = useReview(tabId);
  const number = review?.number ?? -1;
  const placements = useReviewPlacements(tabId);
  const boxes = useReviewUi((s) => boxesOf(s, tabId, number));
  const entries = useMemo(
    () => reviewEntries(mode.stale ? [] : placements?.byPath[path] ?? [], boxes.filter((b) => b.anchor.path === path)),
    [mode.stale, placements, path, boxes],
  );
  const items = useMemo(() => entries.map((e) => e.item), [entries]);
  const sig = JSON.stringify(items);
  const [nodes, setNodes] = useState(NO_NODES);
  /** The box just opened (its zone's key), until it's placed. */
  const [fresh, setFresh] = useState<string | null>(null);
  useEffect(() => {
    if (fresh !== null && nodes.has(fresh)) setFresh(null);
  }, [fresh, nodes]);
  const nodesNow = useRef(nodes);
  nodesNow.current = nodes;
  // The cards' zones: laid by the host (in the frame the diff shows in); their nodes come back in a
  // microtask, rendered before the frame paints, as a WIP diff's hunk rows are.
  useLayoutEffect(() => {
    host?.setReviewZones({ path, items, placed: (n) => queueMicrotask(() => flushSync(() => setNodes(n))) });
  }, [host, path, sig]); // eslint-disable-line react-hooks/exhaustive-deps
  // The spec is matched by path only, and the editor is shared by every tab: hidden (a background
  // tab's `<Activity>`) or gone, the cards go. A layout cleanup, so it runs before the newly shown
  // panel lays its own (a passive one would run after, and take them away).
  useLayoutEffect(() => (host ? () => host.setReviewZones(null) : undefined), [host]);
  const file = mode.stale ? null : mode.file;
  const pick = (h: MonacoHost, side: 'original' | 'modified', from: number, to: number) => {
    if (!file) return;
    const anchor = anchorFor(file, fromMonacoSide(side), from, to);
    if (!anchor) return void useToast.getState().show(NOT_COMMENTABLE);
    // Suggestions are for the new side: what the lines become, in its numbers alone (an old-side
    // drag ending on an unchanged line lands there too: `anchorSpan`).
    const span = anchorSpan(file, anchor);
    const lines = span.side === 'new' ? h.diffLineText('modified', span.from, span.to) : null;
    const key = openBox(tabId, number, anchor, lines ? lines.join('\n') : undefined);
    // A new box takes the keyboard when it mounts; one laid out again later (a tab shown again)
    // doesn't.
    if (!nodesNow.current.has(`b:${key}`)) setFresh(`b:${key}`);
    // Already open there: back to its text.
    nodesNow.current.get(`b:${key}`)?.querySelector('textarea')?.focus();
  };
  const latest = useRef(pick);
  latest.current = pick;
  useEffect(() => {
    if (!host || !file) return;
    host.setReviewGutter({ old: lineSet(file.old), new: lineSet(file.new), onPick: (s, a, b) => latest.current(host, s, a, b) });
    return () => host.setReviewGutter(null);
  }, [host, file]);
  useLend('review.comment', tabId, host && file ? () => { const at = host.diffLines(); if (at) latest.current(host, at.side, at.start, at.end); } : null);
  const step = (dir: 'next' | 'previous') => {
    const key = host?.goToReviewZone(dir);
    // The card's first control; a draft being edited has none but its field.
    if (key) nodesNow.current.get(key)?.querySelector<HTMLElement>('[data-review-focus], textarea')?.focus({ preventScroll: true });
  };
  const leaveOnEsc = (ev: KeyboardEvent) => {
    if (ev.key !== 'Escape' || ev.defaultPrevented || ev.ctrlKey || ev.altKey || ev.metaKey || ev.shiftKey) return;
    ev.preventDefault();
    host?.focus();
  };
  // A box sent or cancelled: the keyboard goes back to the diff, not to the page.
  const closed = (key: string) => {
    closeBox(tabId, number, key);
    host?.focus();
  };
  const stops = entries.some((e) => e.item.stop);
  useLend('review.nextThread', tabId, host && stops ? () => step('next') : null);
  useLend('review.prevThread', tabId, host && stops ? () => step('previous') : null);
  const blocked = blockedNote(mode, review?.kind ?? 'gitlab', number);
  return (
    <>
      <ReviewModeNote tabId={tabId} mode={mode} />
      {entries.map((e) => {
        const node = nodes.get(e.item.key);
        if (!node) return null;
        const card = e.kind === 'thread'
          ? <ThreadCard tabId={tabId} thread={e.thread} outdated={e.outdated} />
          : e.kind === 'draft'
            ? <DraftCard tabId={tabId} draft={e.draft} outdated={e.outdated} onGone={() => host?.focus()} />
            : <CommentBox tabId={tabId} anchor={e.box.anchor} suggestion={e.box.suggestion} disabledReason={blocked} autoFocus={fresh === e.item.key} onDone={() => closed(e.box.key)} onCancel={() => closed(e.box.key)} />;
        // An Esc no control in the card took (the layer owns it: `repo/escape.ts`) leaves the card
        // for the diff; the next one closes the file.
        return createPortal(<div className="review-card-keys" onKeyDown={leaveOnEsc}>{card}</div>, node, e.item.key);
      })}
    </>
  );
}

// Shown in the Keyboard Shortcuts panel (Ctrl+/); metadata only.
registerKeyHints([
  { id: 'key.reviewCardLeave', section: 'Merge request', label: 'Leave the comment card for the diff', keys: ['Esc'], context: '(on a comment card in the diff)', source: 'diff/review/ActiveReview.tsx' },
]);
