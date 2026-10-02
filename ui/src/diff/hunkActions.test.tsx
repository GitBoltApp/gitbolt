import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { Hunk } from '../api/gen/Hunk';
import { HunkButtons, selectedChanges, wipSideOf } from './hunkActions';
import { LineActionBar } from './LineActionBar';

const hunks: Hunk[] = [
  { oldStart: 2, oldLines: 7, newStart: 2, newLines: 7, del: [5], add: [5] },
  { oldStart: 17, oldLines: 7, newStart: 17, newLines: 8, del: [20], add: [20, 21] },
];
const rect = { top: 0, left: 0, bottom: 0 };

describe('hunks and lines (spec #2 §7.3)', () => {
  it('counts only the changed lines a selection covers, on its side', () => {
    expect(selectedChanges(hunks, { side: 'modified', start: 1, end: 30, rect })).toEqual({ old: [], new: [{ start: 5, end: 5 }, { start: 20, end: 21 }], count: 3 });
    expect(selectedChanges(hunks, { side: 'original', start: 18, end: 22, rect })).toEqual({ old: [{ start: 20, end: 20 }], new: [], count: 1 });
    expect(selectedChanges(hunks, { side: 'modified', start: 8, end: 12, rect }).count).toBe(0);
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
});
