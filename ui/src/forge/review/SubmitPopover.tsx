import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import type { ForgeKind } from '../../api/gen/ForgeKind';
import { useModalKeys } from '../../app/modalKeys';
import { DraftCard } from '../../diff/review/DraftCard';
import { usePopoverPlace } from '../../ui/arm/anchor';
import { mrRef } from '../labels';
import { ReviewComposer } from '../mrview/MrActions';
import { isOutdated } from './model';
import { useReview, useReviewPlacements } from './session';
import '../mrview/mrview.css';
import './review.css';

/** Its composer is sending (`aria-busy`): it stays open for the forge's answer (a part-way review
 * shows there). There's one popover at a time. */
const sending = (): boolean => document.querySelector('.review-submit form[aria-busy="true"]') !== null;

/** Mod+Enter in one of the popover's forms (the composer, a draft's edit) submits it: the dialog's
 * keys (`useModalKeys`) take every key before the page's own handlers see it. */
const submitOnModEnter = (e: KeyboardEvent): boolean => {
  if (e.key !== 'Enter' || !(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey) return false;
  const form = e.target instanceof Element ? e.target.closest('form') : null;
  if (!form) return false;
  form.requestSubmit();
  return true;
};

/**
 * Submit review… (spec 2026-10-08 §4): the MR/PR view's review composer, under the top bar's
 * chip (a real choice: Comment, Approve or Request changes). Above it, the pending comments on no
 * line of the diff (no position, an older head's line that's gone, a reply made on the web): the
 * review sends them too, so they're listed here, to read, edit or delete. Esc, Cancel or a press
 * outside closes it, except while it sends; the message stays a draft until it's sent. Lazy: it
 * brings the MR view's styles.
 */
export default function SubmitPopover({ tabId, kind, number, anchor, onClose }: { tabId: string; kind: ForgeKind; number: number; anchor: DOMRect | null; onClose: () => void }) {
  // Mod+Alt+R, which opens it, closes it again.
  const ref = useModalKeys<HTMLDivElement>(true, () => { if (!sending()) onClose(); }, 'Mod+Alt+R', submitOnModEnter);
  const pos = usePopoverPlace(ref, anchor);
  const s = useReview(tabId);
  const placed = useReviewPlacements(tabId);
  const loose = s?.number === number ? placed?.unplacedDrafts ?? [] : [];
  // A deleted one held the keyboard: on to the composer.
  const toComposer = () => ref.current?.querySelector<HTMLElement>('form[aria-label="Review"] textarea')?.focus();
  useEffect(() => {
    const onDown = (e: PointerEvent) => { if (e.target instanceof Node && !ref.current?.contains(e.target) && !sending()) onClose(); };
    window.addEventListener('pointerdown', onDown, true);
    return () => window.removeEventListener('pointerdown', onDown, true);
  }, [ref, onClose]);
  return createPortal(
    <div ref={ref} role="dialog" aria-label={`Submit your review of ${mrRef(kind, number)}`} className="review-submit" style={pos ?? { opacity: 0, left: 0, top: 0 }}>
      {loose.length > 0 && (
        <section className="review-loose" aria-label="Pending comments">
          {loose.map((d) => <DraftCard key={d.id} tabId={tabId} draft={d} outdated={d.position !== null && isOutdated(d.position, s?.refs ?? null)} onGone={toComposer} />)}
        </section>
      )}
      <ReviewComposer tabId={tabId} kind={kind} number={number} onDone={onClose} />
    </div>,
    document.body,
  );
}
