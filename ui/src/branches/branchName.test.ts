import { describe, expect, it } from 'vitest';
import { branchNameError } from './branchName';

/** The same table as Task 1's `branch_names_follow_git` (git is the oracle there). */
const TABLE: Array<[string, boolean]> = [
  ['feature/x', true], ['release.1/ü-x', true], ['a..b', false], ['a b', false], ['a~b', false], ['a^b', false],
  ['a:b', false], ['a?b', false], ['a*b', false], ['a[b', false], ['a\\b', false], ['a@{b', false], ['a/', false],
  ['a//b', false], ['a.', false], ['.a', false], ['a/.b', false], ['a.lock', false], ['a/b.lock/c', false], ['head', true], ['x\u007fy', false],
];

describe('branchNameError (spec #2 §9.1)', () => {
  it.each(TABLE)('%s valid=%s', (name, ok) => expect(branchNameError(name) === null).toBe(ok));
  it('names the reason', () => {
    expect(branchNameError('')).toBe('Enter a branch name');
    expect(branchNameError('HEAD')).toBe("HEAD isn't a branch name");
    expect(branchNameError('-x')).toBe("A branch name can't start with -");
    expect(branchNameError('@')).toBe("A branch name can't be @ or contain @{");
  });
});
