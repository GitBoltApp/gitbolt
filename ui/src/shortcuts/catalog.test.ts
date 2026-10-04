import { describe, expect, it } from 'vitest';
import { filterSections, keycaps, type ShortcutSection } from './catalog';

const all: ShortcutSection[] = [
  { title: 'Navigation', rows: [{ id: 'a', label: 'Next tab', keys: ['Ctrl+Tab'] }] },
  { title: 'Diff', rows: [{ id: 'b', label: 'Next change', keys: ['F7'], context: '(when a diff is open)' }] },
];

describe('shortcut catalog', () => {
  it('splits chords into keycaps', () => {
    expect(keycaps('Ctrl+Shift+T')).toEqual(['Ctrl', 'Shift', 'T']);
    expect(keycaps('Ctrl+/')).toEqual(['Ctrl', '/']);
    expect(keycaps('Ctrl+=')).toEqual(['Ctrl', '=']);
  });
  it('filters by label, key and context, dropping empty sections', () => {
    expect(filterSections(all, 'tab').map((s) => s.title)).toEqual(['Navigation']);
    expect(filterSections(all, 'f7')[0].rows[0].id).toBe('b');
    expect(filterSections(all, 'diff is open')).toHaveLength(1);
    expect(filterSections(all, 'zzz')).toEqual([]);
    expect(filterSections(all, '')).toBe(all);
  });
});
