import { ChevronDown, MessageSquare, Send, Trash2, TriangleAlert } from 'lucide-react';
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import type { ForgeKind } from '../../api/gen/ForgeKind';
import type { ForgeMr } from '../../api/gen/ForgeMr';
import { useLend } from '../../app/lent';
import { useRepoContext } from '../../app/repoContext';
import { openMenuAt } from '../../menu/menuStore';
import type { MenuRow } from '../../menu/types';
import { confirmAction } from '../../ui/ConfirmDialog';
import { HoverTooltip } from '../../ui/HoverTooltip';
import { useToast } from '../../ui/toastStore';
import { forgeName, mrRef } from '../labels';
import { forgeOf, knownMr, useForge, type ReviewSession } from '../mrStore';
import { loadMrDetail, openMrView } from '../poll';
import { discardReview, useReview } from './session';
import './review.css';

const SubmitPopover = lazy(() => import('./SubmitPopover'));

/** What the chip says: its accessible name, its value line, its tooltip, and what's wrong. */
export interface ChipView { name: string; value: string; tooltip: string; problem: string | null }

/**
 * The chip's words (spec 2026-10-08 §4, §7): "Reviewing !12 · 3 pending" ("review pending" for
 * GitHub's pending review with no comment yet). It says when the MR merged or closed under the
 * review, or when the review can't be read (a lost permission is the refresh's error), and the
 * menu still offers Submit and Discard then.
 */
export function chipView(kind: ForgeKind, s: ReviewSession, mr: ForgeMr | null): ChipView {
  const ref = mrRef(kind, s.number);
  const pending = s.drafts.length > 0 ? `${s.drafts.length} pending` : 'review pending';
  const state = mr?.state;
  const ended = s.closed && (state === 'merged' || state === 'closed') ? state : null;
  const value = `${ref}${ended ? ` ${ended}` : ''} · ${pending}`;
  const problem = ended ? `${ref} was ${ended} with your review pending: submit it anyway, or discard it`
    : s.error ? `Couldn't read your pending review: ${s.error}` : null;
  return { name: `Reviewing ${value}`, value, tooltip: problem ?? `Back to ${ref}'s changes and your pending review`, problem };
}

/** What's pending, for the confirm and the toast. */
const pendingText = (n: number) => (n === 0 ? 'your pending review' : n === 1 ? '1 pending comment' : `${n} pending comments`);

/** Back to the review: the MR/PR view, then its Compare (which picks the session up again).
 * Compare's code (and review mode's, which it preloads) loads here, not with the app: the chip is
 * in the entry chunk. */
async function reopenReview(tabId: string, kind: ForgeKind, number: number): Promise<void> {
  openMrView(tabId, number);
  const [{ compareMr }] = await Promise.all([import('../mrview/compare'), loadMrDetail(tabId, number)]);
  const f = forgeOf(tabId);
  const mr = knownMr(f, number);
  if (mr) await compareMr(tabId, kind, mr, f.details[number]?.value ?? null);
}

/**
 * The top bar's review chip (spec 2026-10-08 §4), right of the branch name, while the tab's
 * review session has drafts or a pending GitHub review. A click goes back to the MR's view and
 * Compare; its caret's menu submits the review (Submit review…, also Mod+Alt+R: the composer,
 * under the chip) or discards it (the row arms in place first). The composer, once open, stays
 * while it's needed even if the review ends under it (§7: the forge took the comments but
 * refused the event).
 */
export function ReviewChip() {
  const { tabId } = useRepoContext();
  const s = useReview(tabId);
  const kind = useForge((st) => st.byTab[tabId]?.kind ?? null);
  const mr = useForge((st) => { const f = st.byTab[tabId]; return f && s ? knownMr(f, s.number) : null; });
  const chip = useRef<HTMLButtonElement>(null);
  const shown = !!s && !!kind && (s.drafts.length > 0 || s.pendingReview !== null);
  // The MR it was opened for: it stays open while needed, even once nothing is pending.
  // `fromMenu`: focus comes back to the chip when it closes (the menu it came from is gone); from
  // the key, the popover's own focus trap gives it back to where it was.
  const [submit, setSubmit] = useState<{ kind: ForgeKind; number: number; at: DOMRect | null; fromMenu: boolean } | null>(null);
  const openSubmit = useCallback((fromMenu: boolean) => {
    if (s && kind) setSubmit({ kind, number: s.number, at: chip.current?.getBoundingClientRect() ?? null, fromMenu });
  }, [s, kind]);
  const openFromKey = useCallback(() => openSubmit(false), [openSubmit]);
  const closeSubmit = useCallback(() => setSubmit(null), []);
  // After the popover's focus trap has given focus back (its cleanup runs first).
  const backToChip = useRef(false);
  useEffect(() => {
    if (submit) backToChip.current = submit.fromMenu;
    else if (backToChip.current) {
      backToChip.current = false;
      chip.current?.focus();
    }
  }, [submit]);
  // Mod+Alt+R (`review.submit`, feature.ts), while a review is pending; again, it closes.
  useLend('review.submit', tabId, shown ? openFromKey : null);
  const popover = submit && (
    <Suspense fallback={null}><SubmitPopover tabId={tabId} kind={submit.kind} number={submit.number} anchor={submit.at} onClose={closeSubmit} /></Suspense>
  );
  if (!shown || !s || !kind) return popover;
  const view = chipView(kind, s, mr);
  const ref = mrRef(kind, s.number);
  const what = pendingText(s.drafts.length);
  const discard = async () => {
    if (!(await confirmAction({ title: `Discard ${what} on ${ref}?`, arm: `Click again to discard ${what}`, confirmLabel: 'Discard', danger: true }))) return;
    const out = await discardReview(tabId);
    if (out.ok) useToast.getState().show(`Discarded ${what} on ${ref}`);
    else useToast.getState().show(`Couldn't discard the review: ${out.error}`, { error: true });
  };
  const rows = (): MenuRow[] => [
    { kind: 'action', id: 'review.submitMenu', label: 'Submit review…', icon: Send, tooltip: `Send ${what} on ${ref} as one review: Comment, Approve or Request changes`, run: () => openSubmit(true) },
    { kind: 'action', id: 'review.discard', label: 'Discard pending review', icon: Trash2, tooltip: `Delete ${what} on ${ref} from ${forgeName(kind)}`, run: () => void discard() },
  ];
  return (
    <>
      <div className="tb-split tb-review" data-problem={view.problem ? '' : undefined}>
        <HoverTooltip content={view.tooltip}>
          <button ref={chip} type="button" className="tb-field tb-picker" aria-label={view.name} aria-description={view.problem ?? undefined} onClick={() => void reopenReview(tabId, kind, s.number)}>
            <span className="tb-caption">reviewing</span>
            <span className="tb-value"><MessageSquare size={12} aria-hidden /><span className="tb-review-text">{view.value}</span>{view.problem && <TriangleAlert className="tb-review-warn" size={12} aria-hidden />}</span>
          </button>
        </HoverTooltip>
        <button type="button" className="tb-btn tb-caret" aria-label="Review options" aria-haspopup="menu" onClick={(e) => openMenuAt(e.currentTarget, rows(), undefined, rows, 'Review options')}>
          <ChevronDown size={12} aria-hidden />
        </button>
      </div>
      {popover}
    </>
  );
}
