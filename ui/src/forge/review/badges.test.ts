import { describe, expect, it } from 'vitest';
import { badgeLabel, fileBadge, placementLine } from './badges';
import type { PlacedItem } from './model';

const at = (line: number, startLine: number | null = null, side: 'old' | 'new' = 'new') => ({ path: 'docs/a.md', side, line, startLine, outdated: false });
const note = (system: boolean) => ({ id: 'n', author: { id: 1, username: 'grace', name: 'Grace', avatarUrl: null, webUrl: '', email: null }, body: 'Hm', createdAt: 0, system, position: null });
const thread = (id: string, line: number, resolved = false, system = false): PlacedItem => ({ kind: 'thread', thread: { id, notes: [note(system)], resolvable: true, resolved }, at: at(line) });
const draft = (id: string, line: number): PlacedItem => ({ kind: 'draft', draft: { id, body: id, position: null, replyTo: null }, at: at(line) });

describe("a file's review badge (spec 2026-10-08 §5)", () => {
  it('counts threads and drafts; a click goes to the first unresolved thread', () => {
    expect(fileBadge([thread('a', 2, true), draft('d', 3), thread('b', 9)])).toEqual({ count: 3, threads: 2, drafts: 1, unresolved: 1, first: at(9) });
  });

  it('with every thread resolved, to the first thing on the file', () => {
    expect(fileBadge([draft('d', 3), thread('a', 5, true)])?.first).toEqual(at(3));
  });

  it("doesn't count a thread of system notes alone: neither view shows a card for it", () => {
    expect(fileBadge([thread('s', 1, false, true), draft('d', 3)])).toEqual({ count: 1, threads: 0, drafts: 1, unresolved: 0, first: at(3) });
    expect(fileBadge([thread('s', 1, false, true)])).toBeNull();
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
