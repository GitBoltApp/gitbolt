import { describe, expect, it } from 'vitest';
import { bannerText } from './inProgress';

describe('the conflict banner (spec #2 §13.2)', () => {
  it('names the merge for the user', () => {
    expect(bannerText({ kind: 'merge', mergeHead: 'f'.repeat(40), message: "Merge branch 'feature/x'\n", conflicted: 2 }, { entry: 1, kind: 'merge', label: 'merge feature/x into main', target: 'feature/x' }, 'main', () => null)).toBe('Merging feature/x into main: 2 conflicted files.');
    expect(bannerText({ kind: 'merge', mergeHead: 'f'.repeat(40), message: "Merge branch 'other'\n", conflicted: 1 }, null, 'main', () => null)).toBe('Merging other into main: 1 conflicted file.');
  });
  it('names the rebase step and the stopped commit', () => {
    expect(bannerText({ kind: 'rebase', onto: 'b'.repeat(40), headName: 'refs/heads/main', step: 2, total: 5, stoppedAt: 'a1b2c3d'.padEnd(40, '0'), conflicted: 1 }, { entry: 1, kind: 'rebase', label: 'rebase main onto origin/main', target: 'origin/main' }, null, () => 'Fix x')).toBe('Rebasing main onto origin/main: step 2 of 5, stopped at a1b2c3d Fix x.');
  });
  it('names the branches by their short names: the graph spells them as full refs', () => {
    expect(bannerText({ kind: 'merge', mergeHead: 'f'.repeat(40), message: "Merge branch 'feature/x'\n", conflicted: 3 }, null, 'refs/heads/main', () => null)).toBe('Merging feature/x into main: 3 conflicted files.');
  });
  it('a rebase git started names its onto commit by the branch there, else by its short oid', () => {
    const rebase = { kind: 'rebase', onto: 'b'.repeat(40), headName: 'refs/heads/feature/x', step: 1, total: 1, stoppedAt: 'a1b2c3d'.padEnd(40, '0'), conflicted: 1 } as const;
    expect(bannerText(rebase, null, null, () => 'Feature edits', (sha) => (sha === 'b'.repeat(40) ? 'main' : null))).toBe('Rebasing feature/x onto main: step 1 of 1, stopped at a1b2c3d Feature edits.');
    expect(bannerText(rebase, null, null, () => 'Feature edits')).toBe('Rebasing feature/x onto bbbbbbb: step 1 of 1, stopped at a1b2c3d Feature edits.');
  });
  it('another operation says where to finish it', () => {
    expect(bannerText({ kind: 'other', what: 'cherry-pick' }, null, 'main', () => null)).toBe('A cherry-pick is in progress; finish it in a terminal.');
  });
  it('says it is paused when no conflicted file is left (a cancelled Continue, a kill, a failing hook)', () => {
    const rebase = { kind: 'rebase', onto: 'b'.repeat(40), headName: 'refs/heads/main', step: 1, total: 2, stoppedAt: 'c'.repeat(40), conflicted: 0 } as const;
    expect(bannerText(rebase, null, null, () => null)).toContain('it is paused: Continue to go on');
    expect(bannerText({ kind: 'merge', mergeHead: 'f'.repeat(40), message: "Merge branch 'x'\n", conflicted: 0 }, null, 'main', () => null)).toContain('no conflicted files left; commit the merge');
  });
});
