import { describe, expect, it } from 'vitest';
import type { BranchUpdateOffer } from '../../api/gen/BranchUpdateOffer';
import { branchBehind, defaultUpdate } from './branchUpdate';

describe("the update button's main way", () => {
  const github = ['merge', 'rebase'] as const;
  const gitlab = ['rebase', 'rebaseSkipCi'] as const;

  it('GitHub: a rebase when the repository allows rebase merges, else a merge', () => {
    expect(defaultUpdate('github', github, null, ['merge', 'squash', 'rebase'])).toBe('rebase');
    expect(defaultUpdate('github', github, null, ['merge', 'squash'])).toBe('merge');
    expect(defaultUpdate('github', github, undefined, []), "the repository's settings not loaded yet").toBe('merge');
  });

  it('GitLab: Rebase', () => {
    expect(defaultUpdate('gitlab', gitlab, null, ['fastForward'])).toBe('rebase');
  });

  it("the last way chosen in the repository, when the forge offers it", () => {
    expect(defaultUpdate('github', github, 'merge', ['rebase'])).toBe('merge');
    expect(defaultUpdate('gitlab', gitlab, 'rebaseSkipCi', [])).toBe('rebaseSkipCi');
    expect(defaultUpdate('gitlab', gitlab, 'merge', [])).toBe('rebase');
  });

  it('nothing offered: none', () => {
    expect(defaultUpdate('github', [], 'merge', ['rebase'])).toBeNull();
  });
});

describe('behind its target', () => {
  const offer = (forgeBehind: boolean): BranchUpdateOffer => ({ behind: null, forgeBehind, kinds: ['rebase'], inProgress: false });

  it('the commits say when the repository has them; the forge otherwise', () => {
    expect(branchBehind(true, offer(false)), 'GitHub says behind only when the base requires it').toBe(true);
    expect(branchBehind(null, offer(true))).toBe(true);
    expect(branchBehind(null, offer(false))).toBe(false);
    expect(branchBehind(false, offer(false))).toBe(false);
  });

  it("the forge's behind wins over a remote-tracking target not fetched since", () => {
    expect(branchBehind(false, offer(true))).toBe(true);
  });
});
