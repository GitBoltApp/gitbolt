import { describe, expect, it } from 'vitest';
import { historyEnd, initialHistory, selectedRow, stepSelection, withPage, type FileHistoryArgs } from './model';
import { row } from './testRows';

const args: FileHistoryArgs = { repoId: 1, worktree: '/r', path: 'src/story.txt', rev: null, blame: false };

describe('the File History model (spec #3 §4.2)', () => {
  it('appends pages, skips a row it already has, and selects the first row once', () => {
    let s = withPage(initialHistory(args), { rows: [row('a'), row('b')], more: true });
    expect(s.rows.map((r) => r.sha)).toEqual(['a', 'b']);
    expect(s.selected).toBe('a');
    s = withPage({ ...s, selected: 'b' }, { rows: [row('b'), row('c', 'A')], more: false });
    expect(s.rows.map((r) => r.sha)).toEqual(['a', 'b', 'c']);
    expect(s.selected).toBe('b');
    expect(selectedRow(s)?.sha).toBe('b');
  });

  it('steps the selection within the rows', () => {
    const s = withPage(initialHistory(args), { rows: [row('a'), row('b')], more: false });
    expect(stepSelection(s, 1)).toEqual({ selected: 'b' });
    expect(stepSelection({ ...s, selected: 'b' }, 1)).toEqual({ selected: 'b' });
    expect(stepSelection(s, -1)).toEqual({ selected: 'a' });
  });

  it('"Added in" names the oldest row once the last page is in, if it added the file', () => {
    const more = withPage(initialHistory(args), { rows: [row('a'), row('c', 'A')], more: true });
    expect(historyEnd(more)).toBeNull();
    expect(historyEnd({ ...more, more: false })).toEqual({ addedIn: 'c' });
    expect(historyEnd(withPage(initialHistory(args), { rows: [row('a')], more: false }))).toEqual({ addedIn: null });
    expect(historyEnd({ ...more, more: false, error: 'boom' })).toBeNull();
  });
});
