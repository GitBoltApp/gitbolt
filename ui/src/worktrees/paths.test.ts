import { expect, it } from 'vitest';
import { worktreeDisplay } from './paths';

it('names a worktree beside the main one relatively, else absolutely (spec #2 §9.3)', () => {
  expect(worktreeDisplay('/r/shop', '/r/shop-feature-x')).toBe('../shop-feature-x');
  expect(worktreeDisplay('/r/shop', '/elsewhere/wt')).toBe('/elsewhere/wt');
  expect(worktreeDisplay('/r/shop', '/r/shop')).toBe('/r/shop');
});

it("does the same for Windows paths", () => {
  expect(worktreeDisplay("C:\\r\\shop", "C:\\r\\shop-feature-x")).toBe("../shop-feature-x");
  expect(worktreeDisplay("C:\\r\\shop", "D:\\wt")).toBe("D:\\wt");
});
