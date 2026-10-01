import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ColumnResizer } from './ColumnResizer';
import { allocateColumns, DEFAULT_COLUMN_PREFS, useColumnPrefs } from './columns';

describe('ColumnResizer double-click (K73)', () => {
  it('resets that column to its default width and leaves no drag running', () => {
    useColumnPrefs.setState({ repoId: null, prefs: { ...DEFAULT_COLUMN_PREFS, labels: 320, author: 90 } });
    const cols = allocateColumns({ ...DEFAULT_COLUMN_PREFS, graph: 64, labels: 320, author: 90 }, 1600);
    render(<ColumnResizer col="labels" name="Branch / Tag" cols={cols} available={1600} graphMax={500} />);
    const h = screen.getByRole('separator', { name: 'Resize Branch / Tag column' });
    expect(h).toHaveAttribute('title', 'Drag to resize, double-click to reset');
    fireEvent.pointerDown(h, { clientX: 300, pointerId: 1, button: 0 });
    fireEvent.pointerUp(h, { clientX: 300, pointerId: 1 });
    fireEvent.doubleClick(h);
    expect(useColumnPrefs.getState().prefs.labels).toBe(200);
    expect(useColumnPrefs.getState().prefs.author).toBe(90); // others untouched
    fireEvent.pointerMove(h, { clientX: 500, pointerId: 1 });
    expect(useColumnPrefs.getState().prefs.labels).toBe(200);
    useColumnPrefs.getState().reset();
  });
});
