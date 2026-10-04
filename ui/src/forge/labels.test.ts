import { describe, expect, it } from 'vitest';
import { forgeName, mrLongNoun, mrNoun, mrRef, mrSectionLabel } from './labels';

describe('forge labels: the only place the UI branches on the forge', () => {
  it('says MR and !n for GitLab, PR and #n for GitHub', () => {
    expect([forgeName('gitlab'), mrNoun('gitlab'), mrRef('gitlab', 12), mrSectionLabel('gitlab')]).toEqual(['GitLab', 'MR', '!12', 'Merge requests']);
    expect([forgeName('github'), mrNoun('github'), mrRef('github', 12), mrSectionLabel('github')]).toEqual(['GitHub', 'PR', '#12', 'Pull requests']);
  });
});

// --- 4C T6 ---
it('names the whole noun for menus and buttons', () => {
  expect([mrLongNoun('gitlab'), mrLongNoun('github')]).toEqual(['merge request', 'pull request']);
});
// --- end 4C T6 ---
