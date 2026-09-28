import { describe, expect, it } from 'vitest';
import { renameParts } from './renamePath';

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
