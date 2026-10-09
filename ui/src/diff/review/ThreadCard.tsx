import { ChevronRight } from 'lucide-react';
import { useLayoutEffect, useRef } from 'react';
import type { ForgeDiscussion } from '../../api/gen/ForgeDiscussion';
import { ForgeAvatar } from '../../avatars/Avatar';
import { EMPTY_FORGE, knownMr, useForge } from '../../forge/mrStore';
import { Discussion } from '../../forge/mrview/Thread';
import { useReview } from '../../forge/review/session';
import { useCardFocus } from './cardFocus';
import { cardKey, setCardOpen, useReviewUi } from './store';
import './review.css';

const firstLine = (s: string) => s.split('\n').find((l) => l.trim() !== '')?.trim() ?? '';

/**
 * A published thread under its line (spec 2026-10-08 §2): the MR view's thread (Reply, Reply and
 * resolve, Resolve, reactions) under a header that folds it to one line (who, the first line,
 * how many replies). A resolved thread starts folded; the user's choice is kept for the session.
 * Folding with the keyboard in it hands the keyboard to the toggle.
 */
export function ThreadCard({ tabId, thread, outdated }: { tabId: string; thread: ForgeDiscussion; outdated: boolean }) {
  const review = useReview(tabId);
  const number = review?.number ?? -1;
  const mr = useForge((s) => (review ? knownMr(s.byTab[tabId] ?? EMPTY_FORGE, review.number) : null));
  const key = cardKey(tabId, number, thread.id);
  const chosen = useReviewUi((s) => s.folds[key]);
  const notes = thread.notes.filter((n) => !n.system);
  const first = notes[0];
  const open = chosen ?? !thread.resolved;
  const focus = useCardFocus();
  const toggle = useRef<HTMLButtonElement>(null);
  // Folded with the keyboard in it (Resolve folds a thread): the keyboard goes to its toggle, not
  // to the page.
  useLayoutEffect(() => {
    if (!open && focus.dropped()) toggle.current?.focus({ preventScroll: true });
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!first) return null;
  const replies = notes.length - 1;
  return (
    <div className="review-card review-thread" data-resolved={thread.resolved || undefined} {...focus.props}>
      <div className="review-card-head">
        <button ref={toggle} type="button" className="review-toggle" data-review-focus="" aria-expanded={open} aria-label={`${open ? 'Collapse' : 'Expand'} the thread by ${first.author.name}`} onClick={() => setCardOpen(key, !open)}>
          <ChevronRight size={14} aria-hidden />
        </button>
        {!open && (
          <>
            <ForgeAvatar user={first.author} size={18} />
            <b>{first.author.name}</b>
            <span className="review-excerpt">{firstLine(first.body)}</span>
            {replies > 0 && <span className="review-dim">{replies} {replies === 1 ? 'reply' : 'replies'}</span>}
          </>
        )}
        <span className="mr-spacer" />
        {thread.resolved && <span className="review-chip resolved">Resolved</span>}
        {outdated && <span className="review-chip outdated">Outdated</span>}
      </div>
      {open && mr && review && <Discussion tabId={tabId} kind={review.kind} mr={mr} d={thread} showWhere={false} />}
    </div>
  );
}
