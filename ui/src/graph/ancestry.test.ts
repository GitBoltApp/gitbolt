import { describe, expect, it } from 'vitest';
import type { RowPayload } from '../api/gen/RowPayload';
import { isAncestorIn } from './ancestry';

const r = (id: string, parents: string[]) => ({ id, parents }) as unknown as RowPayload;
// d (merge of b, c) → b → a; c → a; e unrelated root.
const rows = [r('d', ['b', 'c']), r('c', ['a']), r('b', ['a']), r('a', []), r('e', [])];
const index = new Map(rows.map((x, i) => [x.id, i]));

describe('isAncestorIn', () => {
  it('follows every parent, not only the first', () => {
    expect(isAncestorIn(rows, index, 'a', 'd')).toBe(true);
    expect(isAncestorIn(rows, index, 'c', 'd')).toBe(true);
    expect(isAncestorIn(rows, index, 'b', 'd')).toBe(true);
  });
  it('is false for a descendant, a sibling or an unrelated commit; true for the commit itself', () => {
    expect(isAncestorIn(rows, index, 'd', 'a')).toBe(false);
    expect(isAncestorIn(rows, index, 'b', 'c')).toBe(false);
    expect(isAncestorIn(rows, index, 'e', 'd')).toBe(false);
    expect(isAncestorIn(rows, index, 'b', 'b')).toBe(true);
  });
  it('is unknown when either commit is not loaded', () => {
    expect(isAncestorIn(rows, index, 'zz', 'd')).toBeNull();
    expect(isAncestorIn(rows, index, 'a', 'zz')).toBeNull();
  });
});
