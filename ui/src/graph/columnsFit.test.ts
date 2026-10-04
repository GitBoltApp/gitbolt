import { describe, expect, it } from 'vitest';
import { allocateColumns, COLUMN_MIN, DEFAULT_COLUMN_PREFS } from './columns';

describe('allocateColumns with a stored Message width (S.1)', () => {
  const p = { ...DEFAULT_COLUMN_PREFS, graph: 64, message: 400 };
  const fixed = p.labels + 64 + p.author + p.date + p.sha;
  it('a wide window leaves empty space instead of growing Message', () => {
    const w = allocateColumns(p, fixed + 400 + 300);
    expect(w.message).toBe(400);
    expect(w.total).toBe(fixed + 400);
  });
  it('a shrinking window shrinks Message to its minimum first, then Author and Date', () => {
    const mid = allocateColumns(p, fixed + 250);
    expect(mid).toMatchObject({ message: 250, author: p.author, date: p.date });
    const tight = allocateColumns(p, fixed + COLUMN_MIN.message - 30);
    expect(tight.message).toBe(COLUMN_MIN.message);
    expect(tight.author + tight.date).toBe(p.author + p.date - 30);
  });
  it('growing the window again restores the stored widths', () => {
    allocateColumns(p, 600);
    expect(allocateColumns(p, fixed + 400)).toMatchObject({ message: 400, author: p.author, date: p.date });
    expect(p.message).toBe(400);
  });
  it('null still fills the table', () => {
    expect(allocateColumns({ ...p, message: null }, fixed + 700).message).toBe(700);
  });
});
