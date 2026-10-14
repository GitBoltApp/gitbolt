import { describe, expect, it } from 'vitest';
import { makeTestRepo, setIndex } from '../read/testkit';
import { MODE_FILE } from '../read/trees';
import { loadIndex } from './index';
import { hardReset, mixedReset, twoWayMove } from './move';
import { setHead } from './refs';
import { mainWt } from './seam';
import { statusEntries } from './status';

/** from: a.txt, d/b.txt, keep.txt. to: a.txt changed, d/b.txt gone, run.sh (executable), link → a.txt. */
async function repo() {
  const t = await makeTestRepo();
  await t.write('a.txt', 'a\n');
  await t.write('d/b.txt', 'b\n');
  await t.write('keep.txt', 'k\n');
  const from = await t.commit('From');
  await t.write('a.txt', 'A\n');
  await t.remove('d/b.txt');
  await t.write('run.sh', 'run\n', { exec: true });
  await t.link('link', 'a.txt');
  const to = await t.commit('To');
  await t.checkout(from);
  return { t, from, to, wt: mainWt(t.repo) };
}

/** A third commit on `to` where `d` is a file; the worktree back on `from`. */
async function withFileD(t: Awaited<ReturnType<typeof repo>>['t'], from: string, to: string): Promise<string> {
  await t.checkout(to);
  t.memfs.rmdirSync(`${t.dir}/d`); // isomorphic-git's checkout leaves the emptied folder
  await t.write('d', 'now a file\n');
  const fileD = await t.commit('d is a file');
  await t.remove('d'); // isomorphic-git's checkout can't put a folder where a file is
  await t.stage('d');
  await t.checkout(from);
  return fileD;
}

const read = (t: Awaited<ReturnType<typeof repo>>['t'], p: string) => t.memfs.readFileSync(`${t.dir}/${p}`, 'utf8');
const status = async (t: Awaited<ReturnType<typeof repo>>['t']) => (await statusEntries(t.repo, t.dir)).map((e) => [e.path, e.index, e.worktree]);

describe('twoWayMove', () => {
  it("writes the target's files, keeps a local change it doesn't touch, and leaves the index on the target", async () => {
    const { t, from, to, wt } = await repo();
    await t.write('keep.txt', 'mine\n');
    expect(await twoWayMove(wt, from, to, 'checkout')).toEqual(['a.txt', 'd/b.txt', 'link', 'run.sh']);
    setHead(wt, { oid: to }); // as the callers do
    expect([read(t, 'a.txt'), t.memfs.existsSync(`${t.dir}/d`), t.memfs.lstatSync(`${t.dir}/run.sh`).mode & 0o111, t.memfs.readlinkSync(`${t.dir}/link`), read(t, 'keep.txt')]).toEqual(['A\n', false, 0o111, 'a.txt', 'mine\n']);
    expect(await status(t)).toEqual([['keep.txt', '.', 'M']]);
    expect((await loadIndex(wt)).filter((e) => e.path !== 'keep.txt').every((e) => e.stat !== undefined)).toBe(true);
  });

  it("refuses local changes in the way with git's words, changing nothing", async () => {
    const { t, from, to, wt } = await repo();
    await t.write('a.txt', 'mine\n');
    await expect(twoWayMove(wt, from, to, 'checkout')).rejects.toMatchObject({ kind: 'DirtyWorktree', message: 'Your local changes to the following files would be overwritten by checkout:' });
    await expect(twoWayMove(wt, from, to, 'merge')).rejects.toMatchObject({ kind: 'DirtyWorktree', message: 'Your local changes to the following files would be overwritten by merge:' });
    await expect(twoWayMove(wt, from, to, 'readTree')).rejects.toMatchObject({ kind: 'DirtyWorktree', message: "Entry 'a.txt' not uptodate. Cannot merge." });
    expect([read(t, 'a.txt'), t.memfs.existsSync(`${t.dir}/run.sh`)]).toEqual(['mine\n', false]);
    await t.write('a.txt', 'a\n');
    await t.write('run.sh', 'mine\n');
    await expect(twoWayMove(wt, from, to, 'checkout')).rejects.toMatchObject({ kind: 'DirtyWorktree', message: 'The following untracked working tree files would be overwritten by checkout:', stderr: expect.stringContaining('\trun.sh\n') });
    await expect(twoWayMove(wt, from, to, 'readTree')).rejects.toMatchObject({ message: "Untracked working tree file 'run.sh' would be overwritten by merge." });
    t.memfs.mkdirpSync(`${t.repo.gitdir}/info`);
    t.memfs.writeFileSync(`${t.repo.gitdir}/info/exclude`, 'run.sh\n');
    await twoWayMove(wt, from, to, 'checkout');
    expect(read(t, 'run.sh')).toBe('run\n');
  });

  it('brings a locally deleted file back as the target has it, and keeps a path staged to the target', async () => {
    const { t, from, to, wt } = await repo();
    await t.remove('a.txt');
    await t.write('run.sh', 'run\n', { exec: true });
    await t.stage('run.sh');
    await twoWayMove(wt, from, to, 'checkout');
    setHead(wt, { oid: to });
    expect([read(t, 'a.txt'), await status(t)]).toEqual(['A\n', []]);
  });

  it('refuses a conflicted index, and a folder the target replaces while it holds untracked files', async () => {
    const { t, from, to, wt } = await repo();
    const fileD = await withFileD(t, from, to);
    await t.write('d/u.txt', 'u\n');
    await expect(twoWayMove(wt, from, fileD, 'checkout')).rejects.toMatchObject({ kind: 'Other', message: 'Updating the following directories would lose untracked files in them:' });
    await expect(twoWayMove(wt, from, fileD, 'readTree')).rejects.toMatchObject({ message: "Updating 'd' would lose untracked files in it" });
    const [a] = await loadIndex(wt);
    await setIndex(t, [{ ...a, stage: 2 }, { ...a, stage: 3 }]);
    await expect(twoWayMove(wt, from, to, 'checkout')).rejects.toMatchObject({ kind: 'Conflict', message: 'you need to resolve your current index first' });
    await expect(twoWayMove(wt, from, to, 'merge')).rejects.toMatchObject({ kind: 'Other', message: 'Merging is not possible because you have unmerged files.' });
  });

  // Checked against git 2.53 on scratch repositories.
  it("lists staged entries and modified files as separate blocks, then untracked files, as git prints them", async () => {
    const { t, from, to, wt } = await repo();
    await t.write('a.txt', 'mine\n');
    await t.write('d/b.txt', 'x\n');
    await t.stage('d/b.txt');
    await t.write('run.sh', 'mine\n');
    const local = 'error: Your local changes to the following files would be overwritten by checkout:\n';
    const tail = 'Please commit your changes or stash them before you switch branches.\n';
    await expect(twoWayMove(wt, from, to, 'checkout')).rejects.toMatchObject({
      kind: 'DirtyWorktree',
      stderr: `${local}\td/b.txt\n${tail}${local}\ta.txt\n${tail}error: The following untracked working tree files would be overwritten by checkout:\n\trun.sh\nPlease move or remove them before you switch branches.\nAborting\n`,
    });
    const fileD = await withFileD(t, from, to);
    await t.write('d/u.txt', 'u\n');
    await expect(twoWayMove(wt, from, fileD, 'merge')).rejects.toMatchObject({ kind: 'Other', stderr: 'error: Updating the following directories would lose untracked files in them:\n\td\n\nAborting\n' });
  });

  it('drops a staged file neither commit has from a folder the target replaces, unless it changed since', async () => {
    const { t, from, to, wt } = await repo();
    const fileD = await withFileD(t, from, to);
    await t.write('d/x.txt', 'x\n');
    await t.stage('d/x.txt');
    await t.write('d/empty/.keep', '');
    t.memfs.unlinkSync(`${t.dir}/d/empty/.keep`);
    await t.write('d/x.txt', 'changed\n');
    await expect(twoWayMove(wt, from, fileD, 'checkout')).rejects.toMatchObject({ kind: 'DirtyWorktree', stderr: expect.stringContaining('\td/x.txt\n') });
    await expect(twoWayMove(wt, from, fileD, 'readTree')).rejects.toMatchObject({ message: "Entry 'd/x.txt' not uptodate. Cannot merge." });
    await t.write('d/x.txt', 'x\n');
    expect(await twoWayMove(wt, from, fileD, 'readTree')).toEqual(['a.txt', 'd', 'd/b.txt', 'd/x.txt', 'link', 'run.sh']);
    expect([read(t, 'd'), (await loadIndex(wt)).map((e) => e.path)]).toEqual(['now a file\n', ['a.txt', 'd', 'keep.txt', 'link', 'run.sh']]);
  });

  it('refuses a staged or untracked file where the target needs a folder, and overwrites an ignored one', async () => {
    const { t, from, to, wt } = await repo();
    await t.checkout(to);
    await t.write('e/f.txt', 'f\n');
    const withE = await t.commit('e is a folder');
    await t.checkout(from);
    t.memfs.rmdirSync(`${t.dir}/e`); // isomorphic-git's checkout leaves the emptied folder
    await t.write('e', 'mine\n');
    await expect(twoWayMove(wt, from, withE, 'checkout')).rejects.toMatchObject({ message: 'The following untracked working tree files would be overwritten by checkout:', stderr: expect.stringContaining('\te\n') });
    await t.stage('e');
    await expect(twoWayMove(wt, from, withE, 'readTree')).rejects.toMatchObject({ message: "Untracked working tree file 'e' would be overwritten by merge." });
    t.memfs.mkdirpSync(`${t.repo.gitdir}/info`);
    t.memfs.writeFileSync(`${t.repo.gitdir}/info/exclude`, 'e\n');
    expect(await twoWayMove(wt, from, withE, 'checkout')).toContain('e');
    expect([read(t, 'e/f.txt'), (await loadIndex(wt)).some((e) => e.path === 'e')]).toEqual(['f\n', false]);
  });

  it('refuses a tracked file a folder now stands in for: lost when the target drops it and the folder holds untracked files', async () => {
    const { t, from, to, wt } = await repo();
    t.memfs.unlinkSync(`${t.dir}/a.txt`);
    await t.write('a.txt/u.txt', 'u\n');
    await expect(twoWayMove(wt, from, to, 'checkout')).rejects.toMatchObject({ kind: 'DirtyWorktree', stderr: expect.stringContaining('checkout:\n\ta.txt\n') });
    await expect(twoWayMove(wt, from, to, 'readTree')).rejects.toMatchObject({ message: "Entry 'a.txt' not uptodate. Cannot merge." });
    t.memfs.unlinkSync(`${t.dir}/a.txt/u.txt`);
    t.memfs.rmdirSync(`${t.dir}/a.txt`);
    await t.write('a.txt', 'a\n');
    t.memfs.unlinkSync(`${t.dir}/d/b.txt`);
    t.memfs.mkdirSync(`${t.dir}/d/b.txt`);
    await expect(twoWayMove(wt, from, to, 'readTree')).rejects.toMatchObject({ message: "Entry 'd/b.txt' not uptodate. Cannot merge." });
    await t.write('d/b.txt/u.txt', 'u\n');
    await expect(twoWayMove(wt, from, to, 'checkout')).rejects.toMatchObject({ kind: 'Other', message: 'Updating the following directories would lose untracked files in them:', stderr: expect.stringContaining('\td/b.txt\n') });
    await expect(twoWayMove(wt, from, to, 'readTree')).rejects.toMatchObject({ message: "Updating 'd/b.txt' would lose untracked files in it" });
  });

  it('never looks through a symlinked folder', async () => {
    const { t, from, to, wt } = await repo();
    const out = '/demo/out';
    t.memfs.mkdirpSync(out);
    t.memfs.writeFileSync(`${out}/b.txt`, 'b\n');
    t.memfs.unlinkSync(`${t.dir}/d/b.txt`);
    t.memfs.rmdirSync(`${t.dir}/d`);
    t.memfs.symlinkSync('../out', `${t.dir}/d`);
    // Something reached through it is a local change; nothing there, a deleted file.
    await expect(twoWayMove(wt, from, to, 'checkout')).rejects.toMatchObject({ kind: 'DirtyWorktree', stderr: expect.stringContaining('\td/b.txt\n') });
    await expect(twoWayMove(wt, from, to, 'readTree')).rejects.toMatchObject({ message: "Entry 'd/b.txt' not uptodate. Cannot merge." });
    await hardReset(wt, to);
    expect([t.memfs.readlinkSync(`${t.dir}/d`), t.memfs.readFileSync(`${out}/b.txt`, 'utf8')]).toEqual(['../out', 'b\n']);
    await hardReset(wt, from);
    expect([t.memfs.lstatSync(`${t.dir}/d`).isDirectory(), read(t, 'd/b.txt'), t.memfs.readFileSync(`${out}/b.txt`, 'utf8')]).toEqual([true, 'b\n', 'b\n']);
    t.memfs.unlinkSync(`${t.dir}/d/b.txt`);
    t.memfs.rmdirSync(`${t.dir}/d`);
    t.memfs.symlinkSync('../out', `${t.dir}/d`);
    t.memfs.unlinkSync(`${out}/b.txt`);
    await twoWayMove(wt, from, to, 'checkout');
    expect([t.memfs.readlinkSync(`${t.dir}/d`), t.memfs.readdirSync(out)]).toEqual(['../out', []]);
  });

  it("reports read-tree's first problem in git's walk order, a file/folder clash sorting at the name", async () => {
    const t = await makeTestRepo();
    await t.write('d/b.txt', 'b\n');
    await t.write('d-x', 'x\n');
    const from = await t.commit('From');
    await t.write('d/b.txt', 'B\n');
    await t.write('d-x', 'X\n');
    const both = await t.commit('Both change');
    await t.checkout(from);
    const wt = mainWt(t.repo);
    await t.write('d/b.txt', 'mine\n');
    await t.write('d-x', 'mine\n');
    await expect(twoWayMove(wt, from, both, 'readTree')).rejects.toMatchObject({ message: "Entry 'd-x' not uptodate. Cannot merge." });
    await expect(twoWayMove(wt, from, both, 'checkout')).rejects.toMatchObject({ stderr: expect.stringContaining('\td-x\n\td/b.txt\n') });
    await t.checkout(both);
    t.memfs.unlinkSync(`${t.dir}/d/b.txt`);
    t.memfs.rmdirSync(`${t.dir}/d`);
    await t.write('d', 'D\n');
    await t.stage('d/b.txt');
    const clash = await t.commit('d is a file');
    await t.remove('d');
    await t.stage('d');
    await t.checkout(from);
    await t.write('d/b.txt', 'mine\n');
    await t.write('d-x', 'mine\n');
    await expect(twoWayMove(wt, from, clash, 'readTree')).rejects.toMatchObject({ message: "Entry 'd/b.txt' not uptodate. Cannot merge." });
  });
});

describe('resets', () => {
  it('a hard reset puts the index and every tracked file on the target, leaving untracked files', async () => {
    const { t, to, wt } = await repo();
    await t.write('a.txt', 'staged\n');
    await t.stage('a.txt');
    await t.write('n.txt', 'new\n');
    await t.stage('n.txt');
    await t.write('keep.txt', 'mine\n');
    await t.write('u.txt', 'untracked\n');
    const entries = await loadIndex(wt);
    const b = entries.find((e) => e.path === 'd/b.txt')!;
    await setIndex(t, [...entries.filter((e) => e !== b), { ...b, stage: 2 }, { ...b, stage: 3 }]);
    await hardReset(wt, to);
    setHead(wt, { oid: to });
    expect([read(t, 'a.txt'), read(t, 'keep.txt'), t.memfs.existsSync(`${t.dir}/n.txt`), t.memfs.existsSync(`${t.dir}/d`)]).toEqual(['A\n', 'k\n', false, false]);
    expect(await status(t)).toEqual([['u.txt', '?', '?']]);
  });

  it('a hard reset clears a folder in the way and removes an intent-to-add file', async () => {
    const { t, from, to, wt } = await repo();
    const fileD = await withFileD(t, from, to);
    await t.write('d/u.txt', 'u\n');
    await t.write('d/empty/.keep', '');
    t.memfs.unlinkSync(`${t.dir}/d/empty/.keep`);
    await t.write('n.txt', 'n\n');
    const entries = await loadIndex(wt);
    await setIndex(t, [...entries, { path: 'n.txt', mode: MODE_FILE, oid: 'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391', stage: 0, intentToAdd: true }]);
    expect(await hardReset(wt, fileD)).toEqual(['a.txt', 'd', 'd/b.txt', 'link', 'n.txt', 'run.sh']);
    expect([read(t, 'd'), t.memfs.existsSync(`${t.dir}/n.txt`)]).toEqual(['now a file\n', false]);
  });

  it('a mixed reset moves only the index, keeping the stat data of entries it leaves alone', async () => {
    const { t, from, wt } = await repo();
    const keepStat = (await loadIndex(wt)).find((e) => e.path === 'keep.txt')!.stat;
    await t.write('a.txt', 'staged\n');
    await t.stage('a.txt');
    await t.write('d/b.txt', 'B\n');
    await t.stage('d/b.txt');
    await mixedReset(wt, from, ['d']);
    expect(await status(t)).toEqual([['a.txt', 'M', '.'], ['d/b.txt', '.', 'M']]);
    await mixedReset(wt, from);
    expect(await status(t)).toEqual([['a.txt', '.', 'M'], ['d/b.txt', '.', 'M']]);
    expect([(await loadIndex(wt)).find((e) => e.path === 'keep.txt')!.stat, read(t, 'a.txt')]).toEqual([keepStat, 'staged\n']);
    await setIndex(t, [{ path: 'a.txt', mode: MODE_FILE, oid: (await loadIndex(wt))[0].oid, stage: 1 }]);
    await mixedReset(wt, from);
    expect((await loadIndex(wt)).map((e) => [e.path, e.stage])).toEqual([['a.txt', 0], ['d/b.txt', 0], ['keep.txt', 0]]);
  });
});
