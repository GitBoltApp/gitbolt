import { Send } from 'lucide-react';
import { registerActions } from '../../app/actions';
import { lentHandler } from '../../app/lent';
import { registerToolbarChip } from '../../toolbar/registry';
import { ReviewChip } from './ReviewChip';

/** Review comments (spec 2026-10-08 §4): the top bar's chip, and its Submit review… from the
 * keyboard (the chip lends it while a review is pending). */
const offs = [
  registerToolbarChip({ id: 'review.chip', order: 0, Component: ReviewChip }),
  registerActions([{
    id: 'review.submit', label: 'Submit the pending review…', group: 'Repository', section: 'Merge request', icon: Send,
    tooltip: 'Send your pending review comments as one review: Comment, Approve or Request changes', shortcuts: ['Mod+Alt+R'], menu: false,
    when: () => lentHandler('review.submit') !== null,
    run: () => lentHandler('review.submit')?.(),
  }]),
];
import.meta.hot?.dispose(() => offs.forEach((off) => off()));
