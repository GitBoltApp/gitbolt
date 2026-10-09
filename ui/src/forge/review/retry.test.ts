import { describe, expect, it } from 'vitest';
import { retryNote, retryPlan } from './retry';

describe('retryPlan', () => {
  it('sends the review as written when nothing went in', () => {
    expect(retryPlan('approve', 'LGTM', null)).toEqual({ event: 'approve', body: 'LGTM' });
    expect(retryPlan('approve', 'LGTM', { bodyPosted: false, eventSent: false })).toEqual({ event: 'approve', body: 'LGTM' });
  });
  it('sends only the event once the summary is in (Request changes, unapprove refused)', () => {
    expect(retryPlan('requestChanges', 'Fix it', { bodyPosted: true, eventSent: false })).toEqual({ event: 'requestChanges', body: '' });
  });
  it('posts only the summary once the approval is in (note refused)', () => {
    expect(retryPlan('approve', 'LGTM', { bodyPosted: false, eventSent: true })).toEqual({ event: 'comment', body: 'LGTM' });
  });
  it('has nothing extra to post when the approval is in and there is no summary', () => {
    expect(retryPlan('approve', ' ', { bodyPosted: false, eventSent: true })).toEqual({ event: 'approve', body: ' ' });
  });
  it('says what a retry will skip', () => {
    expect(retryNote({ bodyPosted: true, eventSent: false })).toContain('summary is already posted');
    expect(retryNote({ bodyPosted: false, eventSent: true })).toContain('approval went in');
    expect(retryNote(null)).toBe('');
  });
});
