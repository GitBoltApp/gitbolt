import { describe, expect, it } from 'vitest';
import type { InProgress } from '../api/gen/InProgress';
import { CONFLICT_LABEL, conflictSentence, conflictSides } from './sides';

const A = 'a'.repeat(40), B = 'b'.repeat(40), C = 'c'.repeat(40);
const merge: InProgress = { kind: 'merge', mergeHead: A, message: "Merge branch 'feature/x'\n", conflicted: 1 };
const rebase: InProgress = { kind: 'rebase', onto: B, headName: 'refs/heads/feature/x', step: 1, total: 2, stoppedAt: C, editStop: null, editConflict: false, messageFailed: null, gitbolt: false, conflicted: 1, message: '' };
const pick: InProgress = { kind: 'cherryPick', head: C, message: '', conflicted: 1 };
const revert: InProgress = { kind: 'revert', head: C, message: '', conflicted: 1 };
const nameAt = (sha: string) => (sha === B ? 'main' : null);

describe('conflict wording in current/incoming terms (UX round 2)', () => {
  it('never says us or them', () => {
    for (const text of Object.values(CONFLICT_LABEL)) expect(text).not.toMatch(/\b(us|them|ours|theirs)\b/);
    expect(CONFLICT_LABEL.deletedByUs).toBe('deleted in current');
    expect(CONFLICT_LABEL.deletedByThem).toBe('deleted in incoming');
    expect(CONFLICT_LABEL.addedByUs).toBe('added in current');
    expect(CONFLICT_LABEL.bothModified).toBe('changed in both');
  });

  it('a merge: current is the checked-out branch, incoming the merged one', () => {
    const s = conflictSides(merge, 'refs/heads/main', nameAt);
    expect(s).toEqual({ current: 'main', incoming: 'feature/x' });
    expect(conflictSentence('deletedByUs', s)).toBe('Deleted in main (current), modified in feature/x (incoming)');
    // A GitBolt-started merge names its target itself.
    expect(conflictSides(merge, 'refs/heads/main', nameAt, 'origin/feature/x').incoming).toBe('origin/feature/x');
  });

  it("a rebase: git's us is the branch rebased onto (current), them the replayed branch (incoming)", () => {
    const s = conflictSides(rebase, null, nameAt);
    expect(s).toEqual({ current: 'main', incoming: 'feature/x' });
    expect(conflictSentence('deletedByUs', s)).toBe('Deleted in main (current), modified in feature/x (incoming)');
    expect(conflictSentence('deletedByThem', s)).toBe('Modified in main (current), deleted in feature/x (incoming)');
    // No branch at the onto commit: its short sha.
    expect(conflictSides(rebase, null).current).toBe('bbbbbbb');
  });

  it('a cherry-pick: current is the checked-out branch, incoming the picked commit', () => {
    const s = conflictSides(pick, 'refs/heads/main');
    expect(s).toEqual({ current: 'main', incoming: 'ccccccc' });
    expect(conflictSentence('addedByThem', s)).toBe('Added in ccccccc (incoming) only');
  });

  it('a revert: current is the checked-out branch, incoming the revert of the commit', () => {
    const s = conflictSides(revert, 'refs/heads/main');
    expect(s).toEqual({ current: 'main', incoming: 'revert of ccccccc' });
    expect(conflictSentence('bothModified', s)).toBe('Changed in both main (current) and revert of ccccccc (incoming)');
  });

  it('unknown names fall back to the side alone', () => {
    const s = conflictSides(null, null);
    expect(s).toEqual({ current: null, incoming: null });
    expect(conflictSentence('addedByUs', s)).toBe('Added in current only');
    expect(conflictSentence('bothDeleted', { current: 'main', incoming: null })).toBe('Deleted in both main (current) and incoming');
  });
});
