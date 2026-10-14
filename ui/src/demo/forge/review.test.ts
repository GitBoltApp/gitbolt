import { describe, expect, it } from 'vitest';
import type { ForgeKind } from '../../api/gen/ForgeKind';
import type { LineKind } from '../../api/gen/LineKind';
import type { NewReviewComment } from '../../api/gen/NewReviewComment';
import type { ReviewEvent } from '../../api/gen/ReviewEvent';
import type { ReviewLine } from '../../api/gen/ReviewLine';
import { checkComment, checkReviewMessage, commentableLines, DOWN_THE_DIFF, lineCode } from './review';

const rl = (kind: LineKind, oldLine: number, newLine: number): ReviewLine => ({ kind, oldLine, newLine });
const ctx = (o: number, n: number) => rl('context', o, n);
const add = (o: number, n: number) => rl('added', o, n);
const del = (o: number, n: number) => rl('removed', o, n);

function comment(start: ReviewLine | null, end: ReviewLine, body: string): NewReviewComment {
  const refs = { baseSha: 'b'.repeat(40), startSha: 'b'.repeat(40), headSha: 'h'.repeat(40) };
  return { anchor: { path: 'src/app.rs', oldPath: 'src/app.rs', start, end }, body, refs };
}
const messageOf = (f: () => void): string | null => {
  try {
    f();
    return null;
  } catch (e) {
    return (e as Error).message;
  }
};

// Ports of the tests in crates/gitvolt-core/src/forge/review.rs.
describe('review rules', () => {
  it('every line of every hunk takes a comment, numbered as GitLab does', () => {
    const diff = '@@ -1,4 +1,5 @@\n a\n-b\n+B\n+C\n d\n e\n@@ -20,2 +21,3 @@\n t\n+u\n v\n';
    expect(commentableLines(diff)).toEqual([ctx(1, 1), del(2, 2), add(3, 2), add(3, 3), ctx(3, 4), ctx(4, 5), ctx(20, 21), add(21, 22), ctx(21, 23)]);
    // GitHub's `patch` has no trailing newline, and may end with "\ No newline at end of file".
    expect(commentableLines('@@ -1 +1,2 @@\n Readme\n+Second line\n\\ No newline at end of file')).toEqual([ctx(1, 1), add(2, 2)]);
  });

  it("a new file's lines come before old line zero, and no diff has none", () => {
    expect(commentableLines('@@ -0,0 +1,2 @@\n+x\n+y\n')).toEqual([add(0, 1), add(0, 2)]);
    expect(commentableLines('')).toEqual([]);
  });

  it('a hunk ends by its header counts and a blank line is context', () => {
    expect(commentableLines('diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1,2 +1,2 @@\n a\n\n+tail text of a later header\n')).toEqual([ctx(1, 1), ctx(2, 2)]);
  });

  it("a line code is the path's SHA-1 and both numbers", async () => {
    // printf %s README.md | sha1sum
    expect(await lineCode('README.md', add(2, 2))).toBe('8ec9a00bfd09b3190ac6b22251dbb1aa95a0579d_2_2');
    expect(await lineCode('src/app.rs', del(7, 6))).toBe('a841ae12f0c6bcc9fffab1c77aa87ed0e21a0708_7_6');
  });

  it('a comment needs text and a range that runs down the diff', () => {
    expect(messageOf(() => checkComment(comment(null, add(3, 3), '  ')))).toBe('Write a comment first');
    expect(messageOf(() => checkComment(comment(ctx(1, 1), add(3, 3), 'Both?')))).toBeNull();
    expect(messageOf(() => checkComment(comment(del(2, 2), add(3, 2), 'Swap?')))).toBeNull(); // a removed line, then an added one: down the diff
    expect(messageOf(() => checkComment(comment(add(3, 3), ctx(1, 1), 'x')))).toBe(DOWN_THE_DIFF);
    expect(messageOf(() => checkComment(comment(add(3, 3), add(3, 3), 'x')))).toBe(DOWN_THE_DIFF);
    const noHead = comment(null, add(3, 3), 'x');
    noHead.refs.headSha = '';
    expect(messageOf(() => checkComment(noHead))).toBe('Pick a line of the diff first');
  });

  it('one message rule for the composer and the pending review', () => {
    const said = (event: ReviewEvent, body: string, drafts: number, kind: ForgeKind | null) => messageOf(() => checkReviewMessage({ event, body }, drafts, kind));
    expect(said('comment', ' ', 0, null)).toBe('Write a comment first'); // known before the target
    expect(said('requestChanges', '', 0, null)).toBeNull(); // needs the target's kind
    expect(said('requestChanges', '', 0, 'github')).toBe('Say what to change first');
    expect(said('requestChanges', '', 0, 'gitlab')).toBeNull(); // GitLab's retry of a part-way one
    expect(said('comment', '', 2, 'github')).toBeNull(); // the drafts are the review
    expect(said('approve', '', 0, 'github')).toBeNull();
    expect(said('requestChanges', 'Fix it', 0, 'github')).toBeNull();
  });
});
