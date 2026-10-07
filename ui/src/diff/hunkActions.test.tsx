import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { Hunk } from '../api/gen/Hunk';
import { atCursor, HunkButtons, hunkAt, selectedChanges, stagingMenuRows, wipSideOf } from './hunkActions';
import type { MenuRow } from '../menu/types';
import { provideStagingRows, stagingRows } from './stagingMenu';
import { hunkHeader, zoneAfter } from './wipHunks';
import { LineActionBar } from './LineActionBar';

const hunks: Hunk[] = [
  { oldStart: 2, oldLines: 7, newStart: 2, newLines: 7, del: [5], add: [5] },
  { oldStart: 17, oldLines: 7, newStart: 17, newLines: 8, del: [20], add: [20, 21] },
];
const rect = { top: 0, left: 0, bottom: 0 };

describe('the hunk or lines at the cursor (Ctrl+Shift+D)', () => {
  it('takes the selected changed lines, else the hunk the cursor is in', () => {
    expect(atCursor(hunks, { side: 'modified', start: 19, end: 22 }, { side: 'modified', line: 3 })).toEqual({ kind: 'lines', old: [], new: [{ start: 20, end: 21 }] });
    expect(atCursor(hunks, null, { side: 'modified', line: 20 })).toEqual({ kind: 'hunks', hunks: [1] });
    expect(atCursor(hunks, { side: 'modified', start: 10, end: 11 }, { side: 'original', line: 3 })).toEqual({ kind: 'hunks', hunks: [0] });
    expect(atCursor(hunks, null, { side: 'modified', line: 12 })).toBeNull();
    expect(atCursor(hunks, null, null)).toBeNull();
  });
  it('a pure deletion: Next change leaves the cursor on the line after it', () => {
    const del: Hunk[] = [{ oldStart: 4, oldLines: 2, newStart: 3, newLines: 0, del: [4, 5], add: [] }];
    expect(atCursor(del, null, { side: 'modified', line: 4 })).toEqual({ kind: 'hunks', hunks: [0] });
    expect(atCursor(del, null, { side: 'modified', line: 3 })).toEqual({ kind: 'hunks', hunks: [0] });
    expect(atCursor(del, null, { side: 'modified', line: 6 })).toBeNull();
  });
});

describe('hunks and lines (spec #2 §7.3)', () => {
  it('counts only the changed lines a selection covers, on its side', () => {
    expect(selectedChanges(hunks, { side: 'modified', start: 1, end: 30 })).toEqual({ old: [], new: [{ start: 5, end: 5 }, { start: 20, end: 21 }], count: 3 });
    expect(selectedChanges(hunks, { side: 'original', start: 18, end: 22 })).toEqual({ old: [{ start: 20, end: 20 }], new: [], count: 1 });
    expect(selectedChanges(hunks, { side: 'modified', start: 8, end: 12 }).count).toBe(0);
  });

  it('knows a WIP diff’s side from its key, and nothing else', () => {
    const key = (spec: object, path: string) => `${JSON.stringify(spec)}|${path}`;
    expect(wipSideOf({ key: key({ kind: 'wip', worktree: '/r', staged: true }, 'a|b.txt'), path: 'a|b.txt' })).toEqual({ worktree: '/r', staged: true });
    expect(wipSideOf({ key: key({ kind: 'commit', id: 'c', parent: 0 }, 'a.txt'), path: 'a.txt' })).toBeNull();
  });

  it('an unstaged hunk offers Stage and Discard, a staged one Unstage; a reason disables them', () => {
    const stage = vi.fn();
    const { rerender } = render(<HunkButtons staged={false} canDiscard reason={null} onStage={stage} onDiscard={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Stage hunk' }));
    expect(stage).toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Discard hunk' })).toBeInTheDocument();
    rerender(<HunkButtons staged reason={null} canDiscard={false} onStage={stage} onDiscard={() => {}} />);
    expect(screen.getByRole('button', { name: 'Unstage hunk' })).toBeInTheDocument();
    stage.mockClear();
    rerender(<HunkButtons staged={false} canDiscard reason="Save first" onStage={stage} onDiscard={() => {}} />);
    const disabled = screen.getByRole('button', { name: 'Stage hunk' });
    expect(disabled).toHaveAttribute('aria-disabled', 'true');
    fireEvent.click(disabled);
    expect(stage).not.toHaveBeenCalled();
  });

  it('the line bar shows the counts the writes will take, each button its own', () => {
    const apply = vi.fn();
    const { rerender } = render(<LineActionBar rect={rect} apply={2} discard={3} staged={false} canDiscard reason={null} onApply={apply} onDiscard={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Stage 2 lines' }));
    expect(apply).toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Discard 3 lines' })).toBeInTheDocument();
    rerender(<LineActionBar rect={rect} apply={1} discard={1} staged canDiscard={false} reason={null} onApply={apply} onDiscard={() => {}} />);
    expect(screen.getByRole('button', { name: 'Unstage 1 line' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Discard/ })).toBeNull();
  });

  it("finds the hunk a line is in, on its side, context lines included; a header row's place and text", () => {
    expect(hunkAt(hunks, 'modified', 2)).toBe(0);
    expect(hunkAt(hunks, 'modified', 23)).toBe(1);
    expect(hunkAt(hunks, 'original', 24)).toBe(-1);
    expect(hunkAt(hunks, 'modified', 12)).toBe(-1);
    expect(zoneAfter(17, 8)).toBe(16);
    expect(zoneAfter(4, 0)).toBe(4);
    expect(hunkHeader(hunks[1])).toBe('@@ -17,7 +17,8 @@');
  });

  const labels = (rows: MenuRow[]) => rows.map((r) => (r.kind === 'separator' ? '---' : r.label));

  it("the editor menu's rows: this line / these lines, then the clicked line's hunk; staged ones unstage", () => {
    const run = vi.fn();
    const base = { hunks, staged: false, canDiscard: true, reason: null, run };
    const one = stagingMenuRows({ ...base, span: { side: 'modified', start: 5, end: 5 }, hunk: 0 });
    expect(labels(one)).toEqual(['Stage this line', 'Discard this line', '---', 'Stage hunk', 'Discard hunk']);
    const first = one[0];
    if (first.kind === 'action') first.run();
    expect(run).toHaveBeenLastCalledWith({ kind: 'lines', old: [], new: [{ start: 5, end: 5 }] }, false);
    const discardHunk = one[4];
    if (discardHunk.kind === 'action') discardHunk.run();
    expect(run).toHaveBeenLastCalledWith({ kind: 'hunks', hunks: [0] }, true);
    expect(labels(stagingMenuRows({ ...base, span: { side: 'modified', start: 1, end: 30 }, hunk: -1 }))).toEqual(['Stage these lines', 'Discard these lines']);
    // An unchanged line in a hunk: only the hunk. No hunk, nothing changed: no rows.
    expect(labels(stagingMenuRows({ ...base, span: { side: 'modified', start: 3, end: 3 }, hunk: 0 }))).toEqual(['Stage hunk', 'Discard hunk']);
    expect(stagingMenuRows({ ...base, span: { side: 'modified', start: 12, end: 12 }, hunk: -1 })).toEqual([]);
    expect(labels(stagingMenuRows({ ...base, staged: true, canDiscard: false, span: { side: 'original', start: 20, end: 20 }, hunk: 1 }))).toEqual(['Unstage this line', '---', 'Unstage hunk']);
    const disabled = stagingMenuRows({ ...base, reason: 'Save first', span: { side: 'modified', start: 5, end: 5 }, hunk: -1 });
    expect(disabled.every((r) => r.kind === 'action' && r.disabledReason === 'Save first')).toBe(true);
  });

  it('the menu asks the installed provider for diff sides only; a stale removal leaves a newer one', () => {
    const ev = { path: 'a.txt', side: 'modified' as const, line: 1, selection: null, selectionText: '', x: 0, y: 0 };
    const rows: MenuRow[] = [{ kind: 'separator' }];
    const drop = provideStagingRows(() => rows);
    expect(stagingRows(ev)).toBe(rows);
    expect(stagingRows({ ...ev, side: 'file' })).toEqual([]);
    const dropNewer = provideStagingRows(() => []);
    drop();
    expect(stagingRows(ev)).toEqual([]);
    dropNewer();
    expect(stagingRows(ev)).toEqual([]);
  });
});
