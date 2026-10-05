import { describe, expect, it } from 'vitest';
import { growth } from '../test-perf';
import { parseQuery, preparedCount, searchPalette, type PaletteEntry } from './search';

const e = (group: PaletteEntry['group'], label: string): PaletteEntry => ({ id: `${group}:${label}`, group, label, run: () => {} });
const entries = [
  e('action', 'Close tab'), e('action', 'Fetch all'), e('action', 'Find in graph'),
  e('ref', 'feature/login'), e('ref', 'main'),
  e('file', 'src/Login/LoginController.php'), e('file', 'README.md'),
  e('setting', 'Date format'),
  e('tab', 'shop'),
];

describe('palette search', () => {
  it('parses prefixes', () => {
    expect(parseQuery('>fetch')).toEqual({ group: 'action', text: 'fetch' });
    expect(parseQuery('@ main')).toEqual({ group: 'ref', text: 'main' });
    expect(parseQuery('/login')).toEqual({ group: 'file', text: 'login' });
    expect(parseQuery('#date')).toEqual({ group: 'setting', text: 'date' });
    expect(parseQuery('login')).toEqual({ group: null, text: 'login' });
  });

  it('a prefix narrows to one group', () => {
    expect(searchPalette('>f', entries).map((x) => x.label)).toEqual(expect.arrayContaining(['Fetch all', 'Find in graph']));
    expect(searchPalette('>f', entries).every((x) => x.group === 'action')).toBe(true);
  });

  it('without a prefix, all groups are searched and results are ordered by group', () => {
    const groups = searchPalette('login', entries).map((x) => x.group);
    expect(groups).toEqual(['ref', 'file']);
  });

  it("an empty query lists each group's first entries in group order", () => {
    const got = searchPalette('', entries, 1).map((x) => x.label);
    expect(got).toEqual(['Close tab', 'feature/login', 'src/Login/LoginController.php', 'Date format', 'shop']);
  });

  it('caps each group at perGroup without a prefix, and at 50 with one', () => {
    const many = Array.from({ length: 60 }, (_, i) => e('file', `src/file_${i}.txt`));
    expect(searchPalette('file', many)).toHaveLength(8);
    expect(searchPalette('/file', many)).toHaveLength(50);
  });
});

describe('palette search at scale', () => {
  const paths = (n: number) => Array.from({ length: n }, (_, i) => e('file', `src/module_${i % 500}/component_${i}.tsx`));
  const typing = ['/c', '/co', '/com', '/comp', '/compo', '/component_4'];

  it('prepares each entry once per entries array, not per keystroke', () => {
    const many = paths(10_000);
    const before = preparedCount.n;
    for (const q of typing) searchPalette(q, many);
    expect(preparedCount.n - before).toBe(10_000);
    searchPalette('/x', many);
    expect(preparedCount.n - before).toBe(10_000);
  });

  it('ranks 50k paths in linear time: typing a query costs 4x for 4x the paths', () => {
    // Growth, not a budget (see test-perf.ts): preparing fresh entries and six keystrokes over
    // them cost about 4x (4.0-4.1x measured, idle or loaded) from 12.5k to 50k paths; anything per pair would cost 16x.
    const g = growth((n) => { const many = paths(n); return () => { for (const q of typing) searchPalette(q, many); }; }, 12_500);
    expect(g.ratio, `12.5k: ${g.small.toFixed(0)} ms, 50k: ${g.large.toFixed(0)} ms`).toBeLessThan(8);
  }, 60_000);
});
