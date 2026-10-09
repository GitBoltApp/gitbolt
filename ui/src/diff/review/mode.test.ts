import { beforeEach, describe, expect, it } from 'vitest';
import type { DiffPosition } from '../../api/gen/DiffPosition';
import type { ForgeDiscussion } from '../../api/gen/ForgeDiscussion';
import type { ReviewAnchor } from '../../api/gen/ReviewAnchor';
import type { ReviewLine } from '../../api/gen/ReviewLine';
import type { ReviewSession } from '../../forge/mrStore';
import { commentableIndex, type Placement } from '../../forge/review/model';
import { user } from '../../forge/testMrs';
import type { Selection } from '../../repo/store';
import { lineSet, reviewEntries, reviewModeOf, suggestionBlock } from './mode';
import { boxesOf, boxKey, closeBox, openBox, useReviewUi } from './store';

const ctx = (o: number, n: number): ReviewLine => ({ kind: 'context', oldLine: o, newLine: n });
const add = (o: number, n: number): ReviewLine => ({ kind: 'added', oldLine: o, newLine: n });
const FILE = commentableIndex({ path: 'README.md', oldPath: 'README.md', tooLarge: false, lines: [ctx(1, 1), add(2, 2), add(2, 3)] });
const BASE = 'b'.repeat(40);
const HEAD = 'h'.repeat(40);
const NEXT = 'n'.repeat(40);
const REFS = { baseSha: BASE, startSha: BASE, headSha: HEAD };
const COMPARE = { kind: 'compare', from: BASE, to: HEAD } as Selection;
const session = (over: Partial<ReviewSession> = {}): ReviewSession => ({
  number: 12, kind: 'gitlab', compare: { from: BASE, to: HEAD }, refs: REFS, files: { 'README.md': FILE }, diffHead: HEAD,
  drafts: [], pendingReview: null, canDraft: true, closed: false, error: null, loaded: true, ...over,
});
const target = (path: string) => ({ path, view: 'diff' as const });
const pos: DiffPosition = { path: 'README.md', oldPath: null, line: 3, oldLine: null, snippet: null, startLine: null, startOldLine: null };
const thread = (id: string, system = false): ForgeDiscussion => ({ id, resolvable: true, resolved: false, notes: [{ id: `${id}n`, author: user('Grace Hopper'), body: 'Why?', createdAt: 1, system, position: pos }] });
const at = (side: 'old' | 'new', line: number, outdated = false): Placement => ({ path: 'README.md', side, line, startLine: null, outdated });
const anchor: ReviewAnchor = { path: 'README.md', oldPath: 'README.md', start: ctx(1, 1), end: add(2, 3) };

describe('review mode (spec 2026-10-08 §2)', () => {
  it("is on for the session's Compare, for a file of the MR, in Diff View", () => {
    expect(reviewModeOf(session(), COMPARE, target('README.md'))).toEqual({ on: true, stale: false, tooLarge: false, file: FILE });
    expect(reviewModeOf(null, COMPARE, target('README.md')).on).toBe(false);
    // The same commits the other way round, File View, another file: off.
    expect(reviewModeOf(session(), { kind: 'compare', from: HEAD, to: BASE } as Selection, target('README.md')).on).toBe(false);
    expect(reviewModeOf(session(), COMPARE, { path: 'README.md', view: 'file' }).on).toBe(false);
    expect(reviewModeOf(session(), COMPARE, target('other.rs')).on).toBe(false);
  });

  it("before the MR's diff is read, the cards can show and the gutter waits", () => {
    expect(reviewModeOf(session({ refs: null, files: {}, diffHead: null, loaded: false }), COMPARE, target('README.md'))).toEqual({ on: true, stale: false, tooLarge: false, file: null });
  });

  it("is stale once the MR's head moved past the Compare's: its lines aren't the forge's any more", () => {
    expect(reviewModeOf(session({ refs: { ...REFS, headSha: NEXT }, diffHead: NEXT }), COMPARE, target('README.md'))).toEqual({ on: true, stale: true, tooLarge: false, file: null });
    // The MR's detail agreeing with the refs (it moved on): still stale.
    expect(reviewModeOf(session({ refs: { ...REFS, headSha: NEXT }, diffHead: NEXT }), COMPARE, target('README.md'), NEXT)).toEqual({ on: true, stale: true, tooLarge: false, file: null });
  });

  it("right after a push, GitLab's diff refs lag the MR's head: while the head is the Compare's and the refs the last one, it waits (off), not stale", () => {
    const PREV = 'p'.repeat(40);
    const lagging = session({ refs: { ...REFS, headSha: PREV }, diffHead: PREV });
    expect(reviewModeOf(lagging, COMPARE, target('README.md'), HEAD)).toEqual({ on: true, stale: true, updating: true, tooLarge: false, file: null });
    // Caught up: on.
    expect(reviewModeOf(session(), COMPARE, target('README.md'), HEAD)).toEqual({ on: true, stale: false, tooLarge: false, file: FILE });
  });

  it('a file the forge sent no diff for takes no comment', () => {
    expect(reviewModeOf(session({ files: { 'README.md': { ...FILE, tooLarge: true } } }), COMPARE, target('README.md'))).toEqual({ on: true, stale: false, tooLarge: true, file: null });
  });

  it('threads, drafts and open boxes become cards under their lines; only threads and drafts are stops', () => {
    const entries = reviewEntries(
      [{ kind: 'draft', draft: { id: '5', body: 'Hm', position: pos, replyTo: null }, at: at('new', 3) }, { kind: 'thread', thread: thread('d1'), at: at('old', 2, true) }, { kind: 'thread', thread: thread('s1', true), at: at('new', 1) }],
      [{ key: boxKey(anchor), anchor }],
    );
    expect(entries.map((e) => e.item)).toEqual([
      { key: 't:d1', side: 'original', line: 2, startLine: null, stop: true },
      { key: 'd:5', side: 'modified', line: 3, startLine: null, stop: true },
      { key: 'b:README.md:new:1-3', side: 'modified', line: 3, startLine: 1, stop: false },
    ]);
    expect(entries[0]).toMatchObject({ kind: 'thread', outdated: true });
  });

  it("Suggest change's block, in each forge's syntax; a longer fence around code that has one", () => {
    expect(suggestionBlock('github', ['a', 'b'])).toBe('```suggestion\na\nb\n```');
    expect(suggestionBlock('gitlab', ['a', 'b'])).toBe('```suggestion:-1+0\na\nb\n```');
    expect(suggestionBlock('gitlab', ['x'])).toBe('```suggestion:-0+0\nx\n```');
    expect(suggestionBlock('github', ['```js', 'x', '```'])).toBe('````suggestion\n```js\nx\n```\n````');
  });

  it("a file's commentable lines, as a side's set", () => {
    expect([...lineSet(FILE.new)].sort()).toEqual([1, 2, 3]);
    expect([...lineSet(FILE.old)]).toEqual([1]);
  });
});

describe('open comment boxes', () => {
  beforeEach(() => useReviewUi.setState({ boxes: {}, folds: {} }));

  it('one box per anchor, per tab and MR: opening it again keeps the one', () => {
    expect(openBox('t', 12, anchor, 'Second')).toBe('README.md:new:1-3');
    openBox('t', 12, anchor);
    expect(boxesOf(useReviewUi.getState(), 't', 12)).toEqual([{ key: 'README.md:new:1-3', anchor, suggestion: 'Second' }]);
    expect(boxesOf(useReviewUi.getState(), 't', 13)).toEqual([]);
    closeBox('t', 12, 'README.md:new:1-3');
    expect(boxesOf(useReviewUi.getState(), 't', 12)).toEqual([]);
  });
});
