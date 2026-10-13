import * as git from 'isomorphic-git';
import { describe, expect, test } from 'vitest';
import { MemFs, normalisePath, parentOf, redirected } from './memfs';

const code = (f: () => unknown) => {
  try {
    f();
  } catch (e) {
    return (e as { code?: string }).code;
  }
  return 'no error';
};

describe('MemFs', () => {
  test('writes and reads bytes or text; a read is a copy', () => {
    const fs = new MemFs();
    fs.mkdirpSync('/a/b');
    fs.writeFileSync('/a/b/f.txt', 'héllo\n');
    expect(fs.readFileSync('/a/b/f.txt', 'utf8')).toBe('héllo\n');
    const bytes = fs.readFileSync('/a/b/f.txt') as Uint8Array;
    bytes[0] = 0;
    expect(fs.readFileSync('/a/b/f.txt', { encoding: 'utf8' })).toBe('héllo\n');
    expect(fs.statSync('/a/b/f.txt').size).toBe(7);
  });

  test("fails with Node's error codes", () => {
    const fs = new MemFs();
    fs.mkdirpSync('/d/sub');
    fs.writeFileSync('/d/f', 'x');
    expect(code(() => fs.writeFileSync('/missing/f', 'x'))).toBe('ENOENT');
    expect(code(() => fs.mkdirSync('/d'))).toBe('EEXIST');
    expect(code(() => fs.rmdirSync('/d'))).toBe('ENOTEMPTY');
    expect(code(() => fs.unlinkSync('/d/nope'))).toBe('ENOENT');
    expect(code(() => fs.unlinkSync('/d/sub'))).toBe('EISDIR');
    expect(code(() => fs.readdirSync('/d/f'))).toBe('ENOTDIR');
    expect(code(() => fs.readFileSync('/d'))).toBe('EISDIR');
    expect(code(() => fs.readlinkSync('/d/f'))).toBe('EINVAL');
    expect(code(() => fs.statSync('relative/path'))).toBe('EINVAL');
  });

  test('keeps the executable bit and file kinds in the stats', () => {
    const fs = new MemFs();
    fs.writeFileSync('/run.sh', '#!/bin/sh\n', { mode: 0o755 });
    const s = fs.statSync('/run.sh');
    expect([s.mode, s.isFile(), s.isDirectory(), s.isSymbolicLink()]).toEqual([0o100755, true, false, false]);
    expect(fs.statSync('/').isDirectory()).toBe(true);
    expect(fs.statSync('/run.sh').ino).not.toBe(fs.statSync('/').ino);
  });

  test('a rewrite lands in a later second than the write before it', async () => {
    let now = 5_400;
    const fs = new MemFs(() => now);
    fs.writeFileSync('/f', 'one');
    expect(fs.statSync('/f').mtimeMs).toBe(5_400);
    fs.writeFileSync('/f', 'two');
    fs.writeFileSync('/f', 'six');
    expect([fs.statSync('/f').mtimeMs, fs.statSync('/f').ctimeMs]).toEqual([7_000, 7_000]);
    now = 9_250;
    fs.writeFileSync('/f', 'ten');
    expect(fs.statSync('/f').mtimeMs).toBe(9_250);

    // What it's for: a same-size edit right after `add` still shows as modified.
    fs.mkdirpSync('/r');
    await git.init({ fs, dir: '/r' });
    fs.writeFileSync('/r/a.txt', 'aaa');
    await git.add({ fs, dir: '/r', filepath: 'a.txt' });
    fs.writeFileSync('/r/a.txt', 'bbb');
    expect(await git.status({ fs, dir: '/r', filepath: 'a.txt' })).toBe('*added');
  });

  test('symbolic links: stat follows, lstat and readlink do not', () => {
    const fs = new MemFs();
    fs.mkdirpSync('/r/dir');
    fs.writeFileSync('/r/dir/target.txt', 'linked');
    fs.symlinkSync('dir/target.txt', '/r/link');
    expect(fs.readFileSync('/r/link', 'utf8')).toBe('linked');
    expect(fs.lstatSync('/r/link').isSymbolicLink()).toBe(true);
    expect(fs.statSync('/r/link').isFile()).toBe(true);
    expect(fs.readlinkSync('/r/link')).toBe('dir/target.txt');
    expect(fs.existsSync('/r/dangling')).toBe(false);
    fs.symlinkSync('nowhere', '/r/dangling');
    expect([fs.existsSync('/r/dangling'), fs.existsSync('/r/dangling', false)]).toEqual([false, true]);
  });

  test('paths normalise', () => {
    expect(normalisePath('/a//b/./c/../d/')).toBe('/a/b/d');
    expect(parentOf('/a/b/c')).toBe('/a/b');
    expect(parentOf('/a')).toBe('/');
  });

  test('looks like a promise fs to isomorphic-git', async () => {
    const fs = new MemFs();
    expect(Object.getOwnPropertyDescriptor(fs, 'promises')?.enumerable).toBe(true);
    await expect(fs.promises.readFile(undefined as unknown as string)).rejects.toBeTruthy();
    expect(fs.promises.rmdir.length).toBeLessThanOrEqual(1);
    expect('rm' in fs.promises).toBe(false);
  });

  test('isomorphic-git runs a whole round trip on it', async () => {
    const fs = new MemFs();
    fs.mkdirpSync('/r');
    const author = { name: 'Mara Quill', email: 'mara@example.com', timestamp: 1_700_000_000, timezoneOffset: 0 };
    await git.init({ fs, dir: '/r', defaultBranch: 'main' });
    fs.writeFileSync('/r/a.txt', 'one\n');
    fs.mkdirpSync('/r/src');
    fs.writeFileSync('/r/src/b.txt', 'two\n');
    await git.add({ fs, dir: '/r', filepath: '.' });
    const first = await git.commit({ fs, dir: '/r', message: 'First', author });
    fs.writeFileSync('/r/a.txt', 'changed\n');
    fs.writeFileSync('/r/new.txt', 'new\n');
    expect(await git.statusMatrix({ fs, dir: '/r' })).toEqual([['a.txt', 1, 2, 1], ['new.txt', 0, 2, 0], ['src/b.txt', 1, 1, 1]]);
    await git.branch({ fs, dir: '/r', ref: 'feature' });
    expect(await git.listBranches({ fs, dir: '/r' })).toEqual(['feature', 'main']);
    await git.deleteBranch({ fs, dir: '/r', ref: 'feature' });
    expect((await git.log({ fs, dir: '/r' })).map((c) => c.oid)).toEqual([first]);
  });
});

describe('redirected', () => {
  test('reads and writes the mapped paths and leaves the rest alone', async () => {
    const fs = new MemFs();
    fs.mkdirpSync('/g/worktrees/w');
    fs.writeFileSync('/g/HEAD', 'ref: refs/heads/main\n');
    fs.writeFileSync('/g/worktrees/w/HEAD', 'ref: refs/heads/hotfix\n');
    fs.writeFileSync('/g/config', '[core]\n');
    const view = redirected(fs, new Map([['/g/HEAD', '/g/worktrees/w/HEAD'], ['/g/index', '/g/worktrees/w/index']]));
    expect(await view.promises.readFile('/g//HEAD', 'utf8')).toBe('ref: refs/heads/hotfix\n');
    expect(await view.promises.readFile('/g/config', 'utf8')).toBe('[core]\n');
    await view.promises.writeFile('/g/index', 'idx');
    expect(fs.readFileSync('/g/worktrees/w/index', 'utf8')).toBe('idx');
    expect(fs.existsSync('/g/index')).toBe(false);
    await expect(view.promises.readFile(undefined as unknown as string)).rejects.toBeTruthy();
  });
});
