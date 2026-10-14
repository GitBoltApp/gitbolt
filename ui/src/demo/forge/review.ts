// The review rules, a twin of the core's `forge/review.rs`: which lines of an MR's diff take a
// comment, GitLab's line codes, and the checks a comment or review passes before the forge is
// asked. Each function names its Rust one.
import type { ForgeKind } from '../../api/gen/ForgeKind';
import type { NewReviewComment } from '../../api/gen/NewReviewComment';
import type { ReviewLine } from '../../api/gen/ReviewLine';
import type { ReviewSubmit } from '../../api/gen/ReviewSubmit';
import { fail } from '../engine/read/seam';

export const DOWN_THE_DIFF = 'A range runs down the diff, from its first line to its last'; // DOWN_THE_DIFF
export const GITLAB_DRAFT_POSITIONS: [number, number] = [16, 3]; // GITLAB_DRAFT_POSITIONS
export const OLD_GITLAB_DRAFTS = 'This GitLab keeps line comments in a review from version 16.3: use Comment now'; // OLD_GITLAB_DRAFTS

/** `@@ -a[,b] +c[,d] @@…` (`patch.rs` `parse_header`): a missing count is 1. */
function parseHeader(line: string): [number, number, number, number] | null {
  const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))?(?: |$)/.exec(line);
  if (!m) return null;
  return [Number(m[1]), m[2] === undefined ? 1 : Number(m[2]), Number(m[3]), m[4] === undefined ? 1 : Number(m[4])];
}

/** `commentable_lines`: every line of every hunk, in order, numbered as GitLab's diff parser does (`patch.rs` `parse` + `numbered`): an added line keeps the old line it comes before, a removed one the new line. A hunk ends by its header's counts; what follows is header text. */
export function commentableLines(diff: string): ReviewLine[] {
  const out: ReviewLine[] = [];
  const raws = diff.split('\n');
  if (raws[raws.length - 1] === '') raws.pop();
  let at: [number, number] = [0, 0];
  let left: [number, number] = [0, 0];
  let inHunk = false;
  for (const raw of raws) {
    if (raw.startsWith('@@ ')) {
      const h = parseHeader(raw);
      if (h) {
        at = [h[0], h[2]];
        left = [h[1], h[3]];
        inHunk = true;
      }
      continue;
    }
    if (raw.startsWith('\\')) continue;
    if (!inHunk || (left[0] === 0 && left[1] === 0)) continue;
    const c = raw[0];
    // A blank one is `diff.suppressBlankEmpty`'s empty context line, without its space.
    if (c === ' ' || c === undefined) {
      out.push({ kind: 'context', oldLine: at[0], newLine: at[1] });
      at = [at[0] + 1, at[1] + 1];
      left = [Math.max(0, left[0] - 1), Math.max(0, left[1] - 1)];
    } else if (c === '-') {
      out.push({ kind: 'removed', oldLine: at[0], newLine: at[1] });
      at = [at[0] + 1, at[1]];
      left = [Math.max(0, left[0] - 1), left[1]];
    } else if (c === '+') {
      out.push({ kind: 'added', oldLine: at[0], newLine: at[1] });
      at = [at[0], at[1] + 1];
      left = [left[0], Math.max(0, left[1] - 1)];
    }
  }
  return out;
}

/** `line_code`: `<SHA1 of the path>_<old>_<new>`. */
export async function lineCode(path: string, line: ReviewLine): Promise<string> {
  const d = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(path));
  return `${[...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('')}_${line.oldLine}_${line.newLine}`;
}

/** `check_comment`: some text, a file and the head it's against, and a range that runs down the diff. */
export function checkComment(c: NewReviewComment): void {
  if (c.body.trim() === '') fail('InvalidInput', 'Write a comment first');
  if (c.anchor.path === '' || c.refs.headSha === '') fail('InvalidInput', 'Pick a line of the diff first');
  const s = c.anchor.start;
  const e = c.anchor.end;
  if (s && ((s.kind === e.kind && s.oldLine === e.oldLine && s.newLine === e.newLine) || s.oldLine > e.oldLine || s.newLine > e.newLine)) fail('InvalidInput', DOWN_THE_DIFF);
}

/** `check_review_message`: with no drafts going in, Comment needs a message, and so does Request changes except on GitLab. `kind` null: before the target is known. */
export function checkReviewMessage(review: ReviewSubmit, drafts: number, kind: ForgeKind | null): void {
  if (drafts > 0 || review.body.trim() !== '') return;
  if (review.event === 'comment') fail('InvalidInput', 'Write a comment first');
  if (review.event === 'requestChanges' && kind !== null && kind !== 'gitlab') fail('InvalidInput', 'Say what to change first');
}
