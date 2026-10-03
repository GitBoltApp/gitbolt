import { describe, expect, it } from 'vitest';
import type { InProgress } from '../api/gen/InProgress';
import { operationView, withoutComments } from './inProgress';

const merge = (message: string, conflicted: number): InProgress => ({ kind: 'merge', mergeHead: 'f'.repeat(40), message, conflicted });
const rebase = (o: Partial<Extract<InProgress, { kind: 'rebase' }>> = {}): InProgress => ({ kind: 'rebase', onto: 'b'.repeat(40), headName: 'refs/heads/main', step: 2, total: 5, stoppedAt: 'a1b2c3d'.padEnd(40, '0'), conflicted: 1, message: 'Fix x\n\n# Conflicts:\n#\tc.txt\n', ...o });

describe('the commit panel\'s operation status (spec #2 §13.2, ux round 1)', () => {
  it('names the merge for the user, by short names', () => {
    const v = operationView(merge("Merge branch 'feature/x'\n", 2), { entry: 1, kind: 'merge', label: 'merge feature/x into main', target: 'feature/x' }, 'refs/heads/main', () => null);
    expect(v).toMatchObject({ region: 'Merge in progress', title: 'Merging feature/x into main', hint: 'Resolve 2 conflicted files first', primary: 'Commit and merge', skip: false, message: '' });
    expect(operationView(merge("Merge branch 'other'\n", 1), null, 'main', () => null)).toMatchObject({ title: 'Merging other into main', hint: 'Resolve 1 conflicted file first' });
  });

  it('names the rebase step and the stopped commit, and prefills its message without git\'s comments', () => {
    const v = operationView(rebase(), { entry: 1, kind: 'rebase', label: 'rebase main onto origin/main', target: 'origin/main' }, null, () => 'Fix x');
    expect(v).toMatchObject({ region: 'Rebase in progress', title: 'Rebasing main onto origin/main (step 2 of 5)', detail: 'Stopped at a1b2c3d Fix x', primary: 'Continue rebase', skip: true });
    expect(v.message.trim()).toBe('Fix x');
  });

  it('a rebase git started names its onto commit by the branch there, else by its short oid', () => {
    const p = rebase({ headName: 'refs/heads/feature/x', step: 1, total: 1 });
    expect(operationView(p, null, null, () => 'Feature edits', (sha) => (sha === 'b'.repeat(40) ? 'main' : null)).title).toBe('Rebasing feature/x onto main (step 1 of 1)');
    expect(operationView(p, null, null, () => 'Feature edits').title).toBe('Rebasing feature/x onto bbbbbbb (step 1 of 1)');
  });

  it('says it is paused when no conflicted file is left (a cancelled Continue, a kill, a failing hook)', () => {
    expect(operationView(rebase({ conflicted: 0 }), null, null, () => null).hint).toBe('No conflicted files left: it is paused. Continue to go on.');
    expect(operationView(merge("Merge branch 'x'\n", 0), null, 'main', () => null).hint).toBe('No conflicted files left: commit to finish the merge.');
  });

  it('each stop is its own: the box is prefilled once per stop', () => {
    const a = operationView(rebase(), null, null, () => null).stop;
    expect(operationView(rebase({ step: 3, stoppedAt: 'c'.repeat(40) }), null, null, () => null).stop).not.toBe(a);
    expect(operationView(rebase({ conflicted: 0 }), null, null, () => null).stop).toBe(a);
  });

  it('a cherry-pick and a revert have their own Continue', () => {
    const head = 'd'.repeat(40);
    expect(operationView({ kind: 'cherryPick', head, message: 'Pick me\n', conflicted: 1 }, null, 'main', () => 'Pick me')).toMatchObject({ region: 'Cherry-pick in progress', title: 'Cherry-picking ddddddd Pick me', primary: 'Continue cherry-pick', skip: true, message: 'Pick me\n' });
    expect(operationView({ kind: 'revert', head, message: 'Revert "x"\n', conflicted: 0 }, null, 'main', () => null)).toMatchObject({ region: 'Revert in progress', title: 'Reverting ddddddd', primary: 'Continue revert', hint: 'No conflicted files left: Continue to commit the revert.' });
  });

  it('another operation says where to finish it, and has no controls', () => {
    expect(operationView({ kind: 'other', what: 'am' }, null, 'main', () => null)).toMatchObject({ title: 'An am is in progress', hint: 'Finish it in a terminal.', primary: null });
  });

  it('drops git\'s trailing # Conflicts: block', () => {
    expect(withoutComments('Fix\r\n\r\n# Conflicts:\r\n#\tc.txt\r\n')).toBe('Fix\n');
  });

  it('keeps the message\'s own # lines (review 2)', () => {
    const own = 'Fix #12\n\n#123 is the issue\n## Notes\nmore\n';
    expect(withoutComments(own)).toBe(own);
    expect(withoutComments(`${own}\n# Conflicts:\n#\tc.txt\n`)).toBe(own);
  });
});
