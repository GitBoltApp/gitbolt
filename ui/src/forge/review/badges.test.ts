import { describe, expect, it } from 'vitest';
import { badgeLabel, fileBadge, nextStop, placementLine } from './badges';
import type { PlacedItem } from './model';

const at = (line: number, startLine: number | null = null, side: 'old' | 'new' = 'new') => ({ path: 'docs/a.md', side, line, startLine, outdated: false });
const note = (system: boolean) => ({ id: 'n', author: { id: 1, username: 'grace', name: 'Grace', avatarUrl: null, webUrl: '', email: null }, body: 'Hm', createdAt: 0, system, position: null });
const thread = (id: string, line: number, resolved = false, system = false): PlacedItem => ({ kind: 'thread', thread: { id, notes: [note(system)], resolvable: true, resolved }, at: at(line) });
const draft = (id: string, line: number): PlacedItem => ({ kind: 'draft', draft: { id, body: id, position: null, replyTo: null }, at: at(line) });

describe("a file's review badge (spec 2026-10-08 §5)", () => {
  it('counts threads and drafts; its clicks go to the unresolved threads first, then the rest, each in line order', () => {
    const b = fileBadge([thread('a', 2, true), draft('d', 3), thread('b', 9), thread('c', 12)])!;
    expect(b).toMatchObject({ count: 4, threads: 3, drafts: 1, unresolved: 2 });
    expect(b.stops).toEqual([at(9), at(12), at(2), at(3)]);
  });

  it('with every thread resolved, the first thing on the file comes first', () => {
    expect(fileBadge([draft('d', 3), thread('a', 5, true)])?.stops).toEqual([at(3), at(5)]);
  });

  it("doesn't count a thread of system notes alone: neither view shows a card for it", () => {
    expect(fileBadge([thread('s', 1, false, true), draft('d', 3)])).toMatchObject({ count: 1, threads: 0, drafts: 1, unresolved: 0, stops: [at(3)] });
    expect(fileBadge([thread('s', 1, false, true)])).toBeNull();
  });

  it('each click goes to the next stop, round to the first; per file, and from the first again once what is on the file changes', () => {
    const b = fileBadge([thread('a', 2, true), thread('b', 9)])!;
    expect([nextStop('t:12:a.md', b), nextStop('t:12:a.md', b), nextStop('t:12:a.md', b)]).toEqual([at(9), at(2), at(9)]);
    expect(nextStop('t:12:b.md', b)).toEqual(at(9));
    expect(nextStop('t:12:a.md', b)).toEqual(at(2));
    // A thread resolved: the turn starts over.
    const resolved = fileBadge([thread('a', 2, true), thread('b', 9, true)])!;
    expect(nextStop('t:12:a.md', resolved)).toEqual(at(2));
    expect(nextStop('t:12:a.md', resolved)).toEqual(at(9));
  });

  it('nothing on the file: no badge', () => {
    expect(fileBadge([])).toBeNull();
    expect(fileBadge(undefined)).toBeNull();
  });

  it('says what it counts', () => {
    expect(badgeLabel(fileBadge([thread('a', 2, true), draft('d', 3), thread('b', 9)])!)).toBe('2 threads, 1 unresolved, 1 pending');
    expect(badgeLabel(fileBadge([draft('d', 3)])!)).toBe('1 pending');
  });

  it('opens the diff at the placement as a note opens it: a range from its first line', () => {
    expect(placementLine(at(9, 7))).toEqual({ side: 'modified', line: 7, end: 9 });
    expect(placementLine(at(4, null, 'old'))).toEqual({ side: 'original', line: 4 });
  });
});
