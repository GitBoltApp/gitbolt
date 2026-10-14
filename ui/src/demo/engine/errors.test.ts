import { describe, expect, it } from 'vitest';
import { classifyStderr } from './errors';

describe('classifyStderr', () => {
  it("classifies git's messages as the core does, the first rule winning", () => {
    const cases: [string, string][] = [
      ["fatal: Unable to create '/r/.git/index.lock': File exists.", 'IndexLocked'],
      ["error: cannot lock ref 'refs/heads/x': is at 1234 but expected 5678", 'RefMoved'],
      [' ! [rejected]        main -> main (stale info)', 'RefMoved'],
      ["fatal: Authentication failed for 'https://h/x.git/'", 'AuthFailed'],
      ["fatal: could not read Username for 'https://h': terminal prompts disabled", 'AuthFailed'],
      ['fatal: Not possible to fast-forward, aborting.', 'NonFastForward'],
      [' ! [rejected]        main -> main (fetch first)', 'NonFastForward'],
      ["error: the branch 'feature/x' is not fully merged.", 'NonFastForward'],
      ['CONFLICT (content): Merge conflict in a.txt', 'Conflict'],
      ['Conflicts in index. Try without --index.', 'Conflict'],
      ['error: Your local changes to the following files would be overwritten by checkout:', 'DirtyWorktree'],
      ["error: Entry 'a.txt' not uptodate. Cannot merge.", 'DirtyWorktree'],
      ["fatal: 'feature/x' is already checked out at '/r/wt-x'", 'InvalidInput'],
      ['nothing to commit, working tree clean', 'InvalidInput'],
      ['fatal: not a git repository (or any of the parent directories): .git', 'NotFound'],
      ['There is no tracking information for the current branch.', 'NotFound'],
      ['something else entirely', 'Other'],
      // A stash's untracked file in the way of a folder named `x.lock`: the lock rule comes first.
      ["error: Your local changes to the following files would be overwritten by merge:\nfatal: cannot create directory at 'x.lock': File exists\n", 'IndexLocked'],
    ];
    for (const [stderr, kind] of cases) expect([stderr, classifyStderr(stderr)]).toEqual([stderr, kind]);
  });
});
