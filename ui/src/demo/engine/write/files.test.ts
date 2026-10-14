import { describe, expect, it } from 'vitest';
import { makeTestRepo } from '../read/testkit';
import { MODE_EXEC, MODE_FILE, MODE_GITLINK, MODE_LINK } from '../read/trees';
import { checkoutEntry, readFileState, removeWorktreePath, sameFile, writeFileState } from './files';
import { mainWt } from './seam';

const bytes = (s: string) => new TextEncoder().encode(s);

describe('worktree file states', () => {
  it('writes files with their executable bit, links and gitlink folders, and reads them back', async () => {
    const t = await makeTestRepo();
    const wt = mainWt(t.repo);
    writeFileState(wt, 'bin/run.sh', { mode: MODE_EXEC, bytes: bytes('run\n') });
    expect(t.memfs.lstatSync(`${t.dir}/bin/run.sh`).mode & 0o777).toBe(0o755);
    writeFileState(wt, 'link', { mode: MODE_LINK, bytes: bytes('bin/run.sh') });
    expect(t.memfs.readlinkSync(`${t.dir}/link`)).toBe('bin/run.sh');
    writeFileState(wt, 'libs/parser', { mode: MODE_GITLINK, bytes: new Uint8Array() });
    expect(t.memfs.lstatSync(`${t.dir}/libs/parser`).isDirectory()).toBe(true);
    expect(readFileState(wt, 'bin/run.sh')).toEqual({ mode: MODE_EXEC, bytes: bytes('run\n') });
    expect(readFileState(wt, 'link')).toEqual({ mode: MODE_LINK, bytes: bytes('bin/run.sh') });
    expect(readFileState(wt, 'libs/parser')).toBeNull();
    expect(sameFile(readFileState(wt, 'bin/run.sh'), { mode: MODE_EXEC, bytes: bytes('run\n') })).toBe(true);
    expect(sameFile(readFileState(wt, 'bin/run.sh'), { mode: MODE_FILE, bytes: bytes('run\n') })).toBe(false);
  });

  it('removes a file and the folders it leaves empty, never the root', async () => {
    const t = await makeTestRepo();
    const wt = mainWt(t.repo);
    writeFileState(wt, 'a/b/c.txt', { mode: MODE_FILE, bytes: bytes('c\n') });
    writeFileState(wt, 'a/keep.txt', { mode: MODE_FILE, bytes: bytes('k\n') });
    removeWorktreePath(wt, 'a/b/c.txt');
    expect(t.memfs.existsSync(`${t.dir}/a/b`)).toBe(false);
    expect(t.memfs.existsSync(`${t.dir}/a/keep.txt`)).toBe(true);
    writeFileState(wt, 'a/keep.txt', null);
    expect(t.memfs.existsSync(`${t.dir}/a`)).toBe(false);
    expect(t.memfs.existsSync(t.dir)).toBe(true);
  });

  it('replaces a file where a folder must be, and an empty folder where a file goes', async () => {
    const t = await makeTestRepo();
    const wt = mainWt(t.repo);
    writeFileState(wt, 'd', { mode: MODE_FILE, bytes: bytes('file\n') });
    writeFileState(wt, 'd/x.txt', { mode: MODE_FILE, bytes: bytes('x\n') });
    expect(readFileState(wt, 'd/x.txt')?.bytes).toEqual(bytes('x\n'));
    removeWorktreePath(wt, 'd/x.txt');
    t.memfs.mkdirpSync(`${t.dir}/e`);
    writeFileState(wt, 'e', { mode: MODE_FILE, bytes: bytes('e\n') });
    expect(readFileState(wt, 'e')?.bytes).toEqual(bytes('e\n'));
  });

  it('checks a stored blob out', async () => {
    const t = await makeTestRepo();
    await t.write('a.txt', 'a\n');
    await t.commit('Base');
    const wt = mainWt(t.repo);
    const oid = '78981922613b2afb6025042ff6bd878ac1994e85'; // "a\n"
    const stat = await checkoutEntry(wt, 'copy/a.txt', { mode: MODE_FILE, oid });
    expect(stat?.size).toBe(2);
    expect(readFileState(wt, 'copy/a.txt')?.bytes).toEqual(bytes('a\n'));
  });
});
