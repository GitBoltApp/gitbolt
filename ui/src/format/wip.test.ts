import { expect, it } from 'vitest';
import { wipCountsText } from './wip';

const wip = (modified: number, added: number, deleted: number, conflicted: number) => ({ worktreePath: '/r', worktreeName: null, modified, added, deleted, conflicted });

it('lists the non-zero WIP counts as ✎n +n −n ⚠n', () => {
  expect(wipCountsText(wip(2, 1, 3, 4))).toBe('✎2 +1 −3 ⚠4');
  expect(wipCountsText(wip(1, 0, 0, 0))).toBe('✎1');
  expect(wipCountsText(wip(0, 2, 0, 1))).toBe('+2 ⚠1');
  expect(wipCountsText(wip(0, 0, 0, 0))).toBe('');
});
