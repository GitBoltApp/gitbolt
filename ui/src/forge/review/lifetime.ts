import type { ForgeKind } from '../../api/gen/ForgeKind';
import { tabStore } from '../../app/tabStores';
import { forgeOf, forgeScratch, knownMr, patchForge, type ReviewSession } from '../mrStore';
import { reviewAlive } from './model';

/** A review session's upkeep (spec §1 "Lives"): created, patched, watched, ended. */

export function newSession(kind: ForgeKind, number: number, compare: { from: string; to: string } | null): ReviewSession {
  return { number, kind, compare, refs: null, files: {}, diffHead: null, drafts: [], pendingReview: null, canDraft: true, closed: false, error: null, loaded: false };
}

/** Changes the tab's session, if it's still MR `number`'s; a change to nothing new changes nothing. */
export function patchReview(tabId: string, number: number, change: (s: ReviewSession) => Partial<ReviewSession>): void {
  patchForge(tabId, (f) => {
    const cur = f.review;
    if (cur?.number !== number) return {};
    const p = change(cur);
    if ((Object.keys(p) as (keyof ReviewSession)[]).every((k) => p[k] === cur[k])) return {};
    return { review: { ...cur, ...p } };
  });
}

/** The tab shows the session's Compare (its merge base → its head), either way round (Swap). */
export function compareShown(tabId: string, s: ReviewSession): boolean {
  const sel = tabStore(tabId)?.getState().selection;
  if (!s.compare || sel?.kind !== 'compare') return false;
  const { from, to } = s.compare;
  return (sel.from === from && sel.to === to) || (sel.from === to && sel.to === from);
}

export function endReview(tabId: string): void {
  forgeScratch.reviewUnsub.get(tabId)?.();
  forgeScratch.reviewUnsub.delete(tabId);
  forgeScratch.reviewRefs.delete(tabId);
  patchForge(tabId, { review: null });
}

/** Ends the session once nothing keeps it (`reviewAlive`); else notes its MR merged or closed
 * under pending drafts (the chip says so, Plan 3). */
export function settleReview(tabId: string): void {
  const f = forgeOf(tabId);
  const s = f.review;
  if (!s) return;
  const mr = knownMr(f, s.number);
  if (!reviewAlive(s, compareShown(tabId, s), mr)) return endReview(tabId);
  const closed = mr !== null && (mr.state === 'merged' || mr.state === 'closed');
  patchReview(tabId, s.number, () => ({ closed }));
}

/** Settles the session whenever the tab's selection changes (its Compare closing). */
export function watchCompare(tabId: string): void {
  forgeScratch.reviewUnsub.get(tabId)?.();
  const store = tabStore(tabId);
  if (!store) return void forgeScratch.reviewUnsub.delete(tabId);
  forgeScratch.reviewUnsub.set(tabId, store.subscribe((s, prev) => { if (s.selection !== prev.selection) settleReview(tabId); }));
}
