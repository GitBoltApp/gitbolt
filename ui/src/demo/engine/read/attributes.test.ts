import { describe, expect, it } from 'vitest';
import { AttrReader, binaryByAttr, globToRegExp, worktreeEncoding } from './attributes';
import { makeTestRepo } from './testkit';

describe('attributes', () => {
  it('turns patterns into git\'s matching rules', () => {
    const m = (p: string, path: string, dir = '') => globToRegExp(p, dir)?.test(path) ?? false;
    expect(m('*.png', 'art/deep/cover.png')).toBe(true);
    expect(m('*.png', 'art/cover.pngx')).toBe(false);
    expect(m('/top.txt', 'top.txt')).toBe(true);
    expect(m('/top.txt', 'sub/top.txt')).toBe(false);
    expect(m('docs/*.md', 'docs/a.md')).toBe(true);
    expect(m('docs/*.md', 'docs/x/a.md')).toBe(false);
    expect(m('docs/**/*.md', 'docs/x/y/a.md')).toBe(true);
    expect(m('**/fixtures/*', 'a/b/fixtures/c')).toBe(true);
    expect(m('data/**', 'data/x/y.csv')).toBe(true);
    expect(m('file[0-9].txt', 'file7.txt')).toBe(true);
    expect(m('file[!0-9].txt', 'file7.txt')).toBe(false);
    expect(m('*.md', 'sub/x.md', 'sub')).toBe(true);
    expect(m('*.md', 'x.md', 'sub')).toBe(false);
    expect(globToRegExp('build/', '')).toBeNull();
  });

  it('reads root, folder and info files with git\'s precedence', async () => {
    const t = await makeTestRepo();
    await t.write('.gitattributes', '*.png filter=lfs diff=lfs merge=lfs -text\n*.bin binary\n*.txt working-tree-encoding=UTF-16LE\n');
    await t.write('sub/.gitattributes', '*.png -filter\nlegacy.txt !working-tree-encoding\n');
    await t.write('.git/info/attributes', 'forced.png filter=lfs\n');
    const r = new AttrReader(t.repo, t.dir);
    expect((await r.get('art/a.png')).get('filter')).toBe('lfs');
    expect((await r.get('sub/a.png')).get('filter')).toBe(false);
    expect((await r.get('sub/forced.png')).get('filter')).toBe('lfs');
    expect(binaryByAttr(await r.get('x.bin'))).toBe(true);
    expect(binaryByAttr(await r.get('x.png'))).toBe(false);
    expect(worktreeEncoding(await r.get('a.txt'))).toBe('UTF-16LE');
    expect(worktreeEncoding(await r.get('sub/legacy.txt'))).toBeNull();
  });

  it('falls back to the index\'s copy when the worktree has none', async () => {
    const t = await makeTestRepo();
    await t.write('.gitattributes', '*.psd filter=lfs\n');
    await t.commit('Attributes');
    await t.remove('.gitattributes');
    expect((await new AttrReader(t.repo, t.dir).get('a.psd')).get('filter')).toBe('lfs');
  });
});

describe('attributes precedence', () => {
  it('lets later lines, nested files and info win, and unsets with -attr', async () => {
    const t = await makeTestRepo();
    await t.write('.gitattributes', '*.dat a=1 b\n*.dat a=2 -b\nsub/*.dat c\n');
    await t.write('sub/.gitattributes', '*.dat a=3\nx.dat !a\n');
    await t.write('sub/deep/.gitattributes', '*.dat -a\n');
    await t.write('.git/info/attributes', 'sub/deep/z.dat a=info\n');
    const r = new AttrReader(t.repo, t.dir);
    const top = await r.get('q.dat');
    expect(top.get('a')).toBe('2');
    expect(top.get('b')).toBe(false);
    expect((await r.get('sub/q.dat')).get('a')).toBe('3');
    expect((await r.get('sub/q.dat')).get('c')).toBe(true);
    expect((await r.get('sub/x.dat')).has('a')).toBe(false);
    expect((await r.get('sub/deep/q.dat')).get('a')).toBe(false);
    expect((await r.get('sub/deep/z.dat')).get('a')).toBe('info');
  });
});
