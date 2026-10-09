import type { ReviewEvent } from '../../api/gen/ReviewEvent';
import type { SubmitOutcome } from '../../api/gen/SubmitOutcome';

/** What went in before a part-way review, from the forge's answer: the summary note, the event. */
export type Sent = Pick<SubmitOutcome, 'bodyPosted' | 'eventSent'>;

/**
 * What a retry of a part-way review sends, so nothing goes in twice: with the summary already
 * posted, the event alone (no message); with the event already in (an approval) and the summary
 * refused, only the summary, as a Comment.
 */
export function retryPlan(event: ReviewEvent, body: string, sent: Sent | null): { event: ReviewEvent; body: string } {
  if (sent?.bodyPosted && !sent.eventSent) return { event, body: '' };
  if (sent?.eventSent && !sent.bodyPosted && body.trim() !== '') return { event: 'comment', body };
  return { event, body };
}

/** What a retry will skip, said under the part-way message ('' when nothing went in beyond the comments). */
export function retryNote(sent: Sent | null): string {
  if (sent?.bodyPosted && !sent.eventSent) return ' Your summary is already posted, so trying again sends only the rest.';
  if (sent?.eventSent && !sent.bodyPosted) return ' Your approval went in, so trying again posts only your summary.';
  return '';
}
