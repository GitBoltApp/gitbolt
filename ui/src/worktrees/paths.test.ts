import { expect, it } from 'vitest';
import { worktreeDisplay } from './paths';

it('names a worktree beside the main one relatively, else absolutely (spec #2 §9.3)', () => {
  expect(worktreeDisplay('/r/shop', '/r/shop-feature-x')).toBe('../shop-feature-x');
  expect(worktreeDisplay('/r/shop', '/elsewhere/wt')).toBe('/elsewhere/wt');
  expect(worktreeDisplay('/r/shop', '/r/shop')).toBe('/r/shop');
});
