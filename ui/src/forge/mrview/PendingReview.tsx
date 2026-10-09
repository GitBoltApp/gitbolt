import { MessageSquare, Trash2 } from 'lucide-react';
import { useEffect, useId, useRef, type ReactNode } from 'react';
import type { ForgeKind } from '../../api/gen/ForgeKind';
import type { ForgeMr } from '../../api/gen/ForgeMr';
import type { ReviewDraft } from '../../api/gen/ReviewDraft';
import { DraftCard } from '../../diff/review/DraftCard';
import { HoverTooltip } from '../../ui/HoverTooltip';
import { forgeName } from '../labels';
import type { ReviewSession } from '../mrStore';
import { isOutdated, type Placement } from '../review/model';
import { discardPending, pendingText } from '../review/pending';
import { useReviewPlacements } from '../review/session';
import { noteWhere } from './noteLine';
import { openNoteFile } from './openNote';

/** A draft's first line of text, for the list (CSS cuts it to the row). */
const excerpt = (body: string): string => body.split('\n').map((l) => l.trim()).find((l) => l !== '') ?? '';

/**
 * Your pending review (spec 2026-10-08 §4), in the MR/PR view under its header while the tab's
 * review session has one on this MR/PR (`session`): a box with what's pending, open without
 * Review…. Each pending comment on a line of the diff is one row, its `file:line` opening the file
 * at that line (as a thread's does); those on no line of the diff are cards to read, edit or
 * delete (as Submit review… lists them). Then the review composer (`children`), and Discard in
 * the header, which arms in place. With no session, it's only the composer's place (Review…'s
 * composer, or one still answering a send): the composer keeps its place in the tree. `ask`
 * (bumped by the "3 pending" pill and Review…): scroll here and take the keyboard.
 */
export function PendingReview({ tabId, kind, mr, session, ask, children }: { tabId: string; kind: ForgeKind; mr: ForgeMr; session: ReviewSession | null; ask: number; children: ReactNode }) {
  const placed = useReviewPlacements(tabId);
  const box = useRef<HTMLElement>(null);
  const head = useId();
  useEffect(() => {
    if (ask === 0) return;
    box.current?.scrollIntoView?.({ block: 'nearest' });
    box.current?.querySelector<HTMLTextAreaElement>('form[aria-label="Review"] textarea')?.focus({ preventScroll: true });
  }, [ask]);
  const v = session && placed ? { session, placed } : null;
  const on = v !== null;
  const rows: Array<{ draft: ReviewDraft; at: Placement }> = v
    ? Object.keys(v.placed.byPath).sort((a, b) => a.localeCompare(b)).flatMap((p) => v.placed.byPath[p]!.flatMap((it) => (it.kind === 'draft' ? [{ draft: it.draft, at: it.at }] : [])))
    : [];
  const loose = v?.placed.unplacedDrafts ?? [];
  const n = session?.drafts.length ?? 0;
  // A deleted card held the keyboard: on to the composer.
  const toComposer = () => box.current?.querySelector<HTMLElement>('form[aria-label="Review"] textarea')?.focus();
  return (
    <section ref={box} className={on ? 'mr-pending' : 'mr-pending-off'} aria-labelledby={on ? head : undefined} data-pending-review={on || undefined}>
      {v && (
        <div className="mr-pending-head">
          <MessageSquare className="mr-pending-icon" size={14} aria-hidden />
          <h3 id={head} className="mr-pending-title">{n > 0 ? <>Your review <span className="mr-pending-count">· {n} pending</span></> : 'Your pending review'}</h3>
          <HoverTooltip content={`Delete ${pendingText(n)} from ${forgeName(kind)}`}>
            <button type="button" className="mr-button mr-pending-discard" onClick={() => void discardPending(tabId, kind, v.session)}><Trash2 size={12} aria-hidden />Discard</button>
          </HoverTooltip>
        </div>
      )}
      {on && rows.length > 0 && (
        <ul className="mr-pending-list" aria-label="Pending comments">
          {rows.map(({ draft, at }) => (
            <li key={draft.id} className="mr-pending-row">
              <button type="button" className="mr-link mr-where" onClick={() => void openNoteFile(tabId, kind, mr, draft.position!)}>{noteWhere(draft.position!)}</button>
              {at.outdated && <span className="review-chip outdated">Outdated</span>}
              <span className="mr-pending-excerpt">{excerpt(draft.body)}</span>
            </li>
          ))}
        </ul>
      )}
      {on && loose.length > 0 && (
        <div className="mr-pending-loose review-loose" role="group" aria-label="Pending comments">
          {loose.map((d) => <DraftCard key={d.id} tabId={tabId} draft={d} outdated={d.position !== null && isOutdated(d.position, v.session.refs)} onGone={toComposer} />)}
        </div>
      )}
      {children}
    </section>
  );
}
