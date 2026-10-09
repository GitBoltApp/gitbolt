import { describe, expect, it } from 'vitest';
import type { DiffPosition } from '../../api/gen/DiffPosition';
import type { ForgeDiscussion } from '../../api/gen/ForgeDiscussion';
import type { ReviewDraft } from '../../api/gen/ReviewDraft';
import type { ReviewLine } from '../../api/gen/ReviewLine';
import type { ReviewSession } from '../mrStore';
import { mrOf } from '../testMrs';
import { anchorFor, anchorSpan, commentableIndex, fromMonacoSide, isOutdated, placeOf, placeReview, reviewAlive, toMonacoSide } from './model';

const ctx = (o: number, n: number): ReviewLine => ({ kind: 'context', oldLine: o, newLine: n });
const add = (o: number, n: number): ReviewLine => ({ kind: 'added', oldLine: o, newLine: n });
const del = (o: number, n: number): ReviewLine => ({ kind: 'removed', oldLine: o, newLine: n });
// Two hunks: a / -b / +B / +C / d / e, then far below t / +u.
const FILE = commentableIndex({ path: 'src/app.rs', oldPath: 'src/app.rs', tooLarge: false, lines: [ctx(1, 1), del(2, 2), add(3, 2), add(3, 3), ctx(3, 4), ctx(4, 5), ctx(19, 20), add(20, 21)] });
const HEAD = 'h'.repeat(40);
const OLD_HEAD = 'o'.repeat(40);
const REFS = { baseSha: 'b'.repeat(40), startSha: 'b'.repeat(40), headSha: HEAD };
const pos = (over: Partial<DiffPosition>): DiffPosition => ({ path: 'src/app.rs', oldPath: null, line: null, oldLine: null, snippet: null, startLine: null, startOldLine: null, ...over });
const session = (over: Partial<ReviewSession> = {}): ReviewSession => ({
  number: 12, kind: 'gitlab', compare: { from: REFS.baseSha, to: HEAD }, refs: REFS, files: { 'src/app.rs': FILE }, diffHead: HEAD,
  drafts: [], pendingReview: null, canDraft: true, closed: false, error: null, loaded: true, ...over,
});
const draft = (id: string, position: DiffPosition | null): ReviewDraft => ({ id, body: id, position, replyTo: null });
const thread = (id: string, position: DiffPosition): ForgeDiscussion => ({ id, resolvable: true, resolved: false, notes: [{ id, author: { id: 1, username: 'grace', name: 'Grace', avatarUrl: null, webUrl: '', email: null }, body: id, createdAt: 0, system: false, position }] });

describe('commentable lines', () => {
  it('indexes removed lines by their old number, added by their new, and unchanged lines on both sides', () => {
    expect([FILE.old[2], FILE.new[2], FILE.old[1], FILE.new[1]]).toEqual([del(2, 2), add(3, 2), ctx(1, 1), ctx(1, 1)]);
    expect([FILE.old[3], FILE.new[4]]).toEqual([ctx(3, 4), ctx(3, 4)]);
    expect(FILE.new[7]).toBeUndefined();
  });

  it('an anchor covers the selected lines that take a comment, in one hunk', () => {
    expect(anchorFor(FILE, 'new', 3, 1)).toEqual({ path: 'src/app.rs', oldPath: 'src/app.rs', start: ctx(1, 1), end: add(3, 3) });
    expect(anchorFor(FILE, 'old', 2, 2)).toEqual({ path: 'src/app.rs', oldPath: 'src/app.rs', start: null, end: del(2, 2) });
    // From the first hunk into the second: the second's run, which holds the last line.
    expect(anchorFor(FILE, 'new', 4, 21)).toEqual({ path: 'src/app.rs', oldPath: 'src/app.rs', start: ctx(19, 20), end: add(20, 21) });
    expect(anchorFor(FILE, 'new', 7, 15)).toBeNull();
  });

  it("maps Monaco's sides", () => {
    expect([toMonacoSide('old'), toMonacoSide('new'), fromMonacoSide('original'), fromMonacoSide('modified')]).toEqual(['original', 'modified', 'old', 'new']);
  });
});

describe('placement', () => {
  it('a current thread sits at its line, a range from its first', () => {
    expect(placeOf(pos({ line: 3, headSha: HEAD }), REFS, FILE, false)).toEqual({ path: 'src/app.rs', side: 'new', line: 3, startLine: null, outdated: false });
    expect(placeOf(pos({ line: 3, startLine: 1 }), REFS, FILE, false)?.startLine).toBe(1);
    expect(placeOf(pos({ oldLine: 2 }), REFS, FILE, false)?.side).toBe('old');
  });

  it("an outdated published thread stays on the timeline: the forge reports no current line for it", () => {
    expect(isOutdated(pos({ line: 3, outdated: true }), REFS)).toBe(true);
    expect(placeOf(pos({ line: 3, outdated: true }), REFS, FILE, false)).toBeNull();
    expect(placeOf(pos({ line: 3, headSha: OLD_HEAD }), REFS, FILE, false)).toBeNull();
  });

  it('a draft at an older head shows, marked outdated, only where its line is still in the diff', () => {
    expect(placeOf(pos({ line: 3, headSha: OLD_HEAD }), REFS, FILE, true)).toEqual({ path: 'src/app.rs', side: 'new', line: 3, startLine: null, outdated: true });
    expect(placeOf(pos({ line: 9, headSha: OLD_HEAD }), REFS, FILE, true)).toBeNull();
  });

  it("a comment's lines, on the side it lands on, in that side's numbers alone", () => {
    // New side: a range of new lines; one line.
    expect(anchorSpan(FILE, anchorFor(FILE, 'new', 2, 4)!)).toEqual({ side: 'new', from: 2, to: 4 });
    expect(anchorSpan(FILE, anchorFor(FILE, 'new', 1, 1)!)).toEqual({ side: 'new', from: 1, to: 1 });
    // Old side, ending on the removed line: old numbers.
    expect(anchorSpan(FILE, anchorFor(FILE, 'old', 1, 2)!)).toEqual({ side: 'old', from: 1, to: 2 });
    // Old side, ending on an unchanged line (old 3, new 4): the new side, from its first line there.
    expect(anchorFor(FILE, 'old', 2, 3)).toMatchObject({ start: del(2, 2), end: ctx(3, 4) });
    expect(anchorSpan(FILE, anchorFor(FILE, 'old', 2, 3)!)).toEqual({ side: 'new', from: 2, to: 4 });
    expect(anchorSpan(FILE, anchorFor(FILE, 'old', 1, 3)!)).toEqual({ side: 'new', from: 1, to: 4 });
  });

  it('groups threads and drafts by file and lists the drafts that sit nowhere', () => {
    const s = session({ drafts: [draft('d1', pos({ line: 2, headSha: HEAD })), draft('d2', null), draft('d3', pos({ line: 9, headSha: OLD_HEAD })), draft('d4', pos({ path: 'gone.rs', line: 2, headSha: HEAD }))] });
    const placed = placeReview(s, [thread('t1', pos({ line: 3, headSha: HEAD })), thread('t2', pos({ line: 3, outdated: true }))]);
    expect(placed.byPath['src/app.rs']?.map((p) => (p.kind === 'thread' ? p.thread.id : p.draft.id))).toEqual(['d1', 't1']);
    // A file the diff doesn't have is no place either.
    expect(placed.unplacedDrafts.map((d) => d.id)).toEqual(['d2', 'd3', 'd4']);
    expect(placed.byPath['gone.rs']).toBeUndefined();
    // Every draft is one or the other: what the chip counts is what's placed plus what's listed.
    const placedDrafts = Object.values(placed.byPath).flat().filter((p) => p.kind === 'draft').length;
    expect(placedDrafts + placed.unplacedDrafts.length).toBe(s.drafts.length);
  });
});

describe('the session lifetime (spec §1)', () => {
  it('lives while its Compare is shown or a review is pending, and not past a merge with nothing pending', () => {
    expect(reviewAlive(session({ loaded: false }), false, null)).toBe(true);
    // A first refresh that failed knows of nothing pending: it doesn't keep the session.
    expect(reviewAlive(session({ loaded: false, error: 'boom' }), false, null)).toBe(false);
    expect(reviewAlive(session({ loaded: false, error: 'boom' }), true, mrOf(12))).toBe(true);
    expect(reviewAlive(session(), true, mrOf(12))).toBe(true);
    expect(reviewAlive(session(), false, mrOf(12))).toBe(false);
    expect(reviewAlive(session({ drafts: [draft('d1', null)] }), false, mrOf(12, { state: 'merged' }))).toBe(true);
    expect(reviewAlive(session({ pendingReview: 'PRR_9' }), false, null)).toBe(true);
    expect(reviewAlive(session(), true, mrOf(12, { state: 'closed' }))).toBe(false);
  });
});
