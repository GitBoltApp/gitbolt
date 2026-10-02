import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DRAFT_STORAGE_KEY, EMPTY_DRAFT, draftMessage, flushDrafts, normalizeDraft, pruneWipDrafts, readWipDraft, rekeyWipDrafts, reloadDrafts, splitMessage, withMergeMessage, writeWipDraft,
} from './draft';

beforeEach(() => {
  flushDrafts(); // no persist timer left over from another test
  localStorage.clear();
  reloadDrafts();
});

describe('the WIP draft (spec #2 §8.2)', () => {
  it('normalises CRLF and a leading blank description (it would show as two blank lines)', () => {
    expect(normalizeDraft({ summary: 'Fix\r', description: '\r\n\r\nBody\r\nline 2\rline 3' })).toEqual({ summary: 'Fix\n', description: 'Body\nline 2\nline 3' });
    expect(splitMessage('Fix x\r\n\r\nWhy:\r\nbecause\r\n')).toEqual({ summary: 'Fix x', description: 'Why:\nbecause' });
    expect(splitMessage('One line')).toEqual({ summary: 'One line', description: '' });
  });

  it('makes the commit and stash message: the summary, then a blank line and the description', () => {
    expect(draftMessage({ summary: 'Fix x', description: '' })).toBe('Fix x');
    expect(draftMessage({ summary: 'Fix x', description: '  \n ' })).toBe('Fix x');
    expect(draftMessage({ summary: 'Fix x', description: 'Why' })).toBe('Fix x\n\nWhy');
  });

  it('puts MERGE_MSG below the description and keeps the summary; an empty summary takes its first line', () => {
    const merge = "Merge branch 'feature/x'\n\n# Conflicts:\n#\ta.php\n";
    expect(withMergeMessage({ summary: 'Mine', description: 'notes' }, merge)).toEqual({ summary: 'Mine', description: "notes\n\nMerge branch 'feature/x'\n\n# Conflicts:\n#\ta.php" });
    expect(withMergeMessage({ summary: '', description: '' }, merge)).toEqual({ summary: "Merge branch 'feature/x'", description: '# Conflicts:\n#\ta.php' });
  });

  it('keeps one value per repo + worktree, persisted under one v2 key; an empty draft is removed', () => {
    vi.useFakeTimers();
    writeWipDraft('/r', '/r', { summary: 'Main', description: 'body' });
    writeWipDraft('/r', '/r-wt', { summary: 'Linked', description: '' });
    vi.advanceTimersByTime(400);
    const stored = JSON.parse(localStorage.getItem(DRAFT_STORAGE_KEY)!);
    expect(stored['/r\u0000/r']).toEqual({ summary: 'Main', description: 'body' });
    writeWipDraft('/r', '/r-wt', EMPTY_DRAFT);
    flushDrafts();
    expect(JSON.parse(localStorage.getItem(DRAFT_STORAGE_KEY)!)['/r\u0000/r-wt']).toBeUndefined();
    vi.useRealTimers();
  });

  it('migrates the v1 summary and gitbolt.wipBody.v1, then drops the old keys', () => {
    localStorage.setItem('gitbolt.wipDraft.v1:/r\u0000/r', 'Old summary');
    localStorage.setItem('gitbolt.wipBody.v1:/r\u0000/r', '\r\nOld body');
    reloadDrafts();
    expect(readWipDraft('/r', '/r')).toEqual({ summary: 'Old summary', description: 'Old body' });
    expect(localStorage.getItem('gitbolt.wipDraft.v1:/r\u0000/r')).toBeNull();
    expect(localStorage.getItem('gitbolt.wipBody.v1:/r\u0000/r')).toBeNull();
  });

  it('prunes the drafts of worktrees that no longer exist, for that repo only', () => {
    writeWipDraft('/r', '/r', { summary: 'a', description: '' });
    writeWipDraft('/r', '/r-gone', { summary: 'b', description: '' });
    writeWipDraft('/other', '/other-wt', { summary: 'c', description: '' });
    pruneWipDrafts('/r', ['/r']);
    expect(readWipDraft('/r', '/r-gone')).toEqual(EMPTY_DRAFT);
    expect(readWipDraft('/r', '/r').summary).toBe('a');
    expect(readWipDraft('/other', '/other-wt').summary).toBe('c');
  });

  it('a long summary is kept whole: nothing is truncated', () => {
    const long = 'x'.repeat(120);
    writeWipDraft('/r', '/r', { summary: long, description: '' });
    expect(readWipDraft('/r', '/r').summary).toBe(long);
  });

  it('ignores malformed stored entries one by one', () => {
    localStorage.setItem(DRAFT_STORAGE_KEY, JSON.stringify({ a: null, b: 5, c: { summary: 1 }, d: { summary: 'ok', description: 'x' } }));
    reloadDrafts();
    expect(readWipDraft('a', '')).toEqual(EMPTY_DRAFT);
    expect(JSON.parse(localStorage.getItem(DRAFT_STORAGE_KEY)!).d.summary).toBe('ok');
    localStorage.setItem(DRAFT_STORAGE_KEY, 'null');
    expect(() => reloadDrafts()).not.toThrow();
    expect(readWipDraft('/r', '/r')).toEqual(EMPTY_DRAFT);
  });

  it('keeps the v1 keys when the v2 write fails', () => {
    localStorage.setItem('gitbolt.wipDraft.v1:/r\u0000/r', 'Old');
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('quota'); });
    reloadDrafts();
    spy.mockRestore();
    expect(localStorage.getItem('gitbolt.wipDraft.v1:/r\u0000/r')).toBe('Old');
  });

  it('does not prune with an empty list, and never drops the main worktree', () => {
    writeWipDraft('/r', '/r', { summary: 'a', description: '' });
    writeWipDraft('/r', '/r-gone', { summary: 'b', description: '' });
    pruneWipDrafts('/r', []);
    expect(readWipDraft('/r', '/r-gone').summary).toBe('b');
    pruneWipDrafts('/r', ['/r-other']);
    expect(readWipDraft('/r', '/r').summary).toBe('a');
    expect(readWipDraft('/r', '/r-gone')).toEqual(EMPTY_DRAFT);
  });

  it('round-trips a message through split and draftMessage', () => {
    const m = 'Fix x\n\nWhy:\nbecause';
    expect(draftMessage(splitMessage(m))).toBe(m);
  });

  it('works with blocked storage', () => {
    const spy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked'); });
    expect(() => reloadDrafts()).not.toThrow();
    writeWipDraft('/r', '/r', { summary: 'mem', description: '' });
    expect(() => flushDrafts()).not.toThrow();
    expect(readWipDraft('/r', '/r').summary).toBe('mem');
    spy.mockRestore();
  });
});

describe('rekeyWipDrafts (2C T2: one handle per repository)', () => {
  it("moves a linked worktree tab's drafts to the repository's key, never over one already there", () => {
    writeWipDraft('/r-x', '/r-x', { summary: 'Unsent fix', description: 'body' });
    writeWipDraft('/r-x', '/r', { summary: 'old main draft', description: '' });
    writeWipDraft('/r', '/r', { summary: 'main draft', description: '' });
    rekeyWipDrafts('/r-x', '/r');
    expect(readWipDraft('/r', '/r-x')).toEqual({ summary: 'Unsent fix', description: 'body' });
    expect(readWipDraft('/r-x', '/r-x')).toEqual(EMPTY_DRAFT);
    expect(readWipDraft('/r', '/r').summary).toBe('main draft');
    expect(readWipDraft('/r-x', '/r').summary).toBe('old main draft');
    expect(JSON.parse(localStorage.getItem(DRAFT_STORAGE_KEY)!)['/r\u0000/r-x'].summary).toBe('Unsent fix');
  });
});
