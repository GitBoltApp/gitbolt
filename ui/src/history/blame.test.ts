import { describe, expect, it } from 'vitest';
import { colorIndex, groupBlame, visibleGroups } from './blame';

const a = 'a'.repeat(40), b = 'b'.repeat(40);

describe('the blame gutter grouping (spec #3 §3.10, §7)', () => {
  it('merges adjacent hunks of one commit into a group, in line order', () => {
    const groups = groupBlame([{ sha: b, start: 4, lines: 1 }, { sha: a, start: 1, lines: 2 }, { sha: a, start: 3, lines: 1 }, { sha: a, start: 5, lines: 3 }]);
    expect(groups).toEqual([{ sha: a, start: 1, lines: 3 }, { sha: b, start: 4, lines: 1 }, { sha: a, start: 5, lines: 3 }]);
  });

  it('keeps the groups that overlap the lines on screen', () => {
    const groups = groupBlame([{ sha: a, start: 1, lines: 3 }, { sha: b, start: 4, lines: 1 }, { sha: a, start: 5, lines: 3 }]);
    expect(visibleGroups(groups, 3, 4).map((g) => g.start)).toEqual([1, 4]);
    expect(visibleGroups(groups, 8, 9)).toEqual([]);
    expect(visibleGroups(groups, 1, 0)).toEqual([]);
  });

  it('gives a commit the same colour every time, within the palette', () => {
    expect(colorIndex(a, 10)).toBe(colorIndex(a, 10));
    const many = new Set(Array.from({ length: 20 }, (_, i) => colorIndex(i.toString(16).padStart(40, '0'), 10)));
    expect(many.size).toBeGreaterThan(3);
    for (const i of many) {
      expect(i).toBeGreaterThanOrEqual(0);
      expect(i).toBeLessThan(10);
    }
  });
});
