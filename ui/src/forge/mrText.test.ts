import { describe, expect, it } from 'vitest';
import { badgeLabel, branchesText, conflictText, pipelineText, reviewText } from './mrText';
import { mrOf, user } from './testMrs';

const ada = user('Ada Lovelace');
const hubot = user('Hubot');

describe('the words of an MR/PR (the only forge-specific ones are in labels.ts)', () => {
  it('names a badge', () => {
    expect(badgeLabel('gitlab', 12, 'open')).toBe('Merge request !12: open');
    expect(badgeLabel('github', 3, 'draft')).toBe('Pull request #3: draft');
  });

  it("says a pipeline the forge's way", () => {
    expect(pipelineText('gitlab', { status: 'success', webUrl: null })).toBe('Pipeline passed');
    expect(pipelineText('github', { status: 'failed', webUrl: null })).toBe('Checks failed');
    expect(pipelineText('gitlab', { status: 'manual', webUrl: null })).toBe('Pipeline waiting for a manual job');
    expect(pipelineText('gitlab', null)).toBe('No pipeline');
    expect(pipelineText('github', null)).toBe('No checks');
  });

  it('says the review state', () => {
    const r = (decision: 'approved' | 'changesRequested' | 'reviewRequired' | 'none', reviews: { user: typeof ada; state: 'approved' | 'changesRequested' | 'commented' | 'pending' }[], approvalsRequired: number | null = null) =>
      reviewText({ decision, approvals: reviews.filter((x) => x.state === 'approved').length, approvalsRequired, reviews: reviews.map((x) => ({ ...x, submittedAt: null })) });
    expect(r('approved', [{ user: ada, state: 'approved' }, { user: hubot, state: 'approved' }])).toBe('Approved by Ada Lovelace, Hubot');
    expect(r('approved', [{ user: ada, state: 'approved' }], 1)).toBe('1 of 1 approval');
    expect(r('changesRequested', [{ user: hubot, state: 'changesRequested' }])).toBe('Changes requested by Hubot');
    expect(r('changesRequested', [])).toBe('Changes requested by a reviewer');
    expect(r('reviewRequired', [{ user: ada, state: 'pending' }])).toBe('Review requested from Ada Lovelace');
    expect(r('reviewRequired', [], 2)).toBe('0 of 2 approvals');
    expect(r('reviewRequired', [])).toBe('Review required');
    expect(r('none', [])).toBe('No reviews yet');
  });

  it('says conflicts and the branches, a fork by its owner', () => {
    expect([conflictText(true), conflictText(false), conflictText(null)]).toEqual(['Has conflicts', 'No conflicts', 'Checking for conflicts…']);
    expect(branchesText(mrOf(12))).toBe('dev → main');
    expect(branchesText(mrOf(14, { sourceProject: 'alice/project', sourceBranch: 'fix' }))).toBe('alice:fix → main');
  });
});
