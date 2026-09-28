import { describe, expect, it } from 'vitest';
import { renameHighlight, renameParts } from './renameParts';

describe('renameHighlight (J15)', () => {
  const split = (a: string, b: string) => {
    const r = renameHighlight(a, b);
    // Each side's three parts are its whole path.
    expect(r.old.join('')).toBe(a);
    expect(r.new.join('')).toBe(b);
    return r;
  };

  it('a name change inside one directory: only the changed word of the name', () => {
    expect(split('admin/dist/assets/PriceRanges-Dspn_3uo.js', 'admin/dist/assets/PriceRanges-DYuKwOSt.js')).toEqual({
      old: ['admin/dist/assets/PriceRanges-', 'Dspn_3uo', '.js'],
      new: ['admin/dist/assets/PriceRanges-', 'DYuKwOSt', '.js'],
    });
    expect(split('docs/guide.txt', 'docs/manual.txt')).toEqual({ old: ['docs/', 'guide', '.txt'], new: ['docs/', 'manual', '.txt'] });
  });

  it('a directory change: a segment in the middle of the path', () => {
    expect(split('src/old/x.ts', 'src/new/x.ts')).toEqual({ old: ['src/', 'old', '/x.ts'], new: ['src/', 'new', '/x.ts'] });
    // The shared "ts" ending of "components" / "widgets" doesn't split the word.
    expect(split('src/components/Button.tsx', 'src/widgets/Button.tsx')).toEqual({ old: ['src/', 'components', '/Button.tsx'], new: ['src/', 'widgets', '/Button.tsx'] });
  });

  it('an extension change: the whole extension, not one letter of it', () => {
    expect(split('src/app.js', 'src/app.ts')).toEqual({ old: ['src/app.', 'js', ''], new: ['src/app.', 'ts', ''] });
  });

  it('a move into a subdirectory, or out of one: only the side that has it is highlighted', () => {
    expect(split('a/x.ts', 'a/b/x.ts')).toEqual({ old: ['a/', '', 'x.ts'], new: ['a/', 'b/', 'x.ts'] });
    expect(split('a/b/x.ts', 'a/x.ts')).toEqual({ old: ['a/', 'b/', 'x.ts'], new: ['a/', '', 'x.ts'] });
    // A pure suffix change.
    expect(split('notes', 'notes.md')).toEqual({ old: ['notes', '', ''], new: ['notes', '.md', ''] });
  });

  it('a change that starts inside a word takes the whole word, on both sides', () => {
    expect(split('lib/bar.ts', 'lib/barbaz.ts')).toEqual({ old: ['lib/', 'bar', '.ts'], new: ['lib/', 'barbaz', '.ts'] });
  });

  it('completely different paths', () => {
    expect(split('x/a.txt', 'y/z/b.txt')).toEqual({ old: ['', 'x/a', '.txt'], new: ['', 'y/z/b', '.txt'] });
    expect(split('abc', 'xyz')).toEqual({ old: ['', 'abc', ''], new: ['', 'xyz', ''] });
  });

  it('paths that differ only in case: the words whose case changed', () => {
    expect(split('README.md', 'readme.md')).toEqual({ old: ['', 'README', '.md'], new: ['', 'readme', '.md'] });
    expect(split('src/Foo/bar.ts', 'src/foo/bar.ts')).toEqual({ old: ['src/', 'Foo', '/bar.ts'], new: ['src/', 'foo', '/bar.ts'] });
  });

  it('works on code points: an emoji is never split into lone surrogates, and astral letters are words', () => {
    // 😀 U+1F600 and 😁 U+1F601 share their high surrogate.
    expect(split('docs/😀.md', 'docs/😁.md')).toEqual({ old: ['docs/', '😀', '.md'], new: ['docs/', '😁', '.md'] });
    // 𝐀𝐁 / 𝐀𝐂 (mathematical bold letters, outside the BMP): the whole word.
    expect(split('a/𝐀𝐁.txt', 'a/𝐀𝐂.txt')).toEqual({ old: ['a/', '𝐀𝐁', '.txt'], new: ['a/', '𝐀𝐂', '.txt'] });
    const lone = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
    for (const part of [...split('x/😀😀.md', 'x/😀😁.md').old, ...split('x/😀😀.md', 'x/😀😁.md').new]) expect(part).not.toMatch(lone);
  });

  it('the common prefix and suffix never overlap, in either path', () => {
    // "d/aa" → "d/aaa": the naive prefix (4) and suffix (4) would both claim old's "aa".
    expect(split('d/aa', 'd/aaa')).toEqual({ old: ['d/', 'aa', ''], new: ['d/', 'aaa', ''] });
    expect(split('d/aaa', 'd/aa')).toEqual({ old: ['d/', 'aaa', ''], new: ['d/', 'aa', ''] });
    expect(split('x/y', 'x/y')).toEqual({ old: ['x/y', '', ''], new: ['x/y', '', ''] });
  });
});

describe('renameParts (H21)', () => {
  it('same directory: the common base, then only the file names', () => {
    expect(renameParts('admin/dist/assets/PriceRanges-Dspn_3uo.js', 'admin/dist/assets/PriceRanges-DYuKwOSt.js')).toEqual({
      common: 'admin/dist/assets/',
      old: 'PriceRanges-Dspn_3uo.js',
      newDir: '',
      newName: 'PriceRanges-DYuKwOSt.js',
    });
  });

  it('shares whole directories only, never part of a name', () => {
    expect(renameParts('src/app/x.ts', 'src/application/x.ts')).toEqual({ common: 'src/', old: 'app/x.ts', newDir: 'application/', newName: 'x.ts' });
    expect(renameParts('docs/guide.txt', 'docs2/guide.txt')).toEqual({ common: '', old: 'docs/guide.txt', newDir: 'docs2/', newName: 'guide.txt' });
  });

  it('a move into a subdirectory, and one up', () => {
    expect(renameParts('a/x.ts', 'a/b/x.ts')).toEqual({ common: 'a/', old: 'x.ts', newDir: 'b/', newName: 'x.ts' });
    expect(renameParts('a/b/x.ts', 'a/x.ts')).toEqual({ common: 'a/', old: 'b/x.ts', newDir: '', newName: 'x.ts' });
  });

  it('completely different paths, and files at the root', () => {
    expect(renameParts('x/a.txt', 'y/z/b.txt')).toEqual({ common: '', old: 'x/a.txt', newDir: 'y/z/', newName: 'b.txt' });
    expect(renameParts('a.txt', 'b.txt')).toEqual({ common: '', old: 'a.txt', newDir: '', newName: 'b.txt' });
  });

  it('a file name that is also a directory name elsewhere is not a directory', () => {
    // "docs" is a file in the old path and a directory in the new one.
    expect(renameParts('docs', 'docs/readme')).toEqual({ common: '', old: 'docs', newDir: 'docs/', newName: 'readme' });
  });
});
