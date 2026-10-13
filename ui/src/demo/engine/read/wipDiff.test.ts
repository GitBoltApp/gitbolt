import { describe, expect, it } from 'vitest';
import { baseOf, BINARY, CONFLICTED, hunkSummary, LFS_WHOLE, SUBMODULE, SYMLINK, TOO_LARGE, TYPECHANGE, wipDiff, type WipDiff } from './wipDiff';
import { MODE_FILE, MODE_GITLINK } from './trees';
import { readIndex } from './indexFile';
import { makeTestRepo, setIndex, writeNested } from './testkit';

const forty = (changed: number[]) => Array.from({ length: 40 }, (_, k) => k + 1).map((i) => (changed.includes(i) ? `app ${i} changed\n` : `app ${i}\n`)).join('');
const hunksOf = (d: WipDiff | string) => (typeof d === 'string' ? d : d.hunks.map(hunkSummary));

/** The hunks as `git diff` prints them, without a function name after the header. */
function render(d: WipDiff | string): string {
  if (typeof d === 'string') return d;
  const range = (start: number, n: number) => (n === 1 ? `${start}` : `${start},${n}`);
  const mark = { context: ' ', del: '-', add: '+' };
  return d.hunks
    .map((h) => `@@ -${range(h.oldStart, h.oldLines)} +${range(h.newStart, h.newLines)} @@\n` + h.lines.map((l) => mark[l.kind] + l.text + (l.noEol ? '\n\\ No newline at end of file\n' : '')).join(''))
    .join('');
}

const NO_EOL = '\\ No newline at end of file\n';

describe('WIP diffs', () => {
  it("gives each side's hunks and the blobs they came from", async () => {
    const t = await makeTestRepo();
    await t.write('src/app.txt', forty([]));
    await t.write('a.txt', 'A\n');
    await t.commit('Base');
    await t.write('src/app.txt', forty([5, 20, 35]));
    await t.write('a.txt', 'A\nstaged\n');
    await t.stage('a.txt');
    await t.write('a.txt', 'A\nstaged\nmore\n');
    await t.write('n.txt', 'one\ntwo\n');
    expect(hunksOf(await wipDiff(t.repo, t.dir, 'src/app.txt', false))).toEqual([
      { oldStart: 2, oldLines: 7, newStart: 2, newLines: 7, del: [5], add: [5] },
      { oldStart: 17, oldLines: 7, newStart: 17, newLines: 7, del: [20], add: [20] },
      { oldStart: 32, oldLines: 7, newStart: 32, newLines: 7, del: [35], add: [35] },
    ]);
    expect(hunksOf(await wipDiff(t.repo, t.dir, 'a.txt', true))).toEqual([{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 2, del: [], add: [2] }]);
    expect(hunksOf(await wipDiff(t.repo, t.dir, 'a.txt', false))).toEqual([{ oldStart: 1, oldLines: 2, newStart: 1, newLines: 3, del: [], add: [3] }]);
    expect(hunksOf(await wipDiff(t.repo, t.dir, 'n.txt', false))).toEqual([{ oldStart: 0, oldLines: 0, newStart: 1, newLines: 2, del: [], add: [1, 2] }]);
    expect(hunksOf(await wipDiff(t.repo, t.dir, 'n.txt', true))).toEqual([]);
    const base = await baseOf(t.repo, t.dir, 'a.txt');
    expect(base.head).not.toBeNull();
    expect(base.index).not.toBe(base.head);
    expect(base.worktree).toMatch(/^[0-9a-f]{40}$/);
    expect((await baseOf(t.repo, t.dir, 'n.txt')).index).toBeNull();
  });

  it('diffs a deleted file, and a file gone with its folder has no worktree id', async () => {
    const t = await makeTestRepo();
    await t.write('sub/f.txt', 'f\n');
    await t.commit('Base');
    await t.remove('sub/f.txt');
    t.memfs.rmdirSync(`${t.dir}/sub`);
    expect(hunksOf(await wipDiff(t.repo, t.dir, 'sub/f.txt', false))).toEqual([{ oldStart: 1, oldLines: 1, newStart: 0, newLines: 0, del: [1], add: [] }]);
    const base = await baseOf(t.repo, t.dir, 'sub/f.txt');
    expect(base.worktree).toBeNull();
    expect(base.index).toBe(base.head);
  });

  // Each expectation is `git diff -U3` of the same two files (git 2.53), from the first `@@`.
  it('flags the lines without a final newline, and keeps CR bytes, as git does', async () => {
    const cases: [string, string, string][] = [
      ['a\nb', 'a\nc', `@@ -1,2 +1,2 @@\n a\n-b\n${NO_EOL}+c\n${NO_EOL}`],
      ['a\nb', 'a\nb\nc\n', `@@ -1,2 +1,3 @@\n a\n-b\n${NO_EOL}+b\n+c\n`],
      ['a\nb\n', 'a\nb', `@@ -1,2 +1,2 @@\n a\n-b\n+b\n${NO_EOL}`],
      ['a\nb\nx', 'a\nB\nx', `@@ -1,3 +1,3 @@\n a\n-b\n+B\n x\n${NO_EOL}`],
      ['a\r\nb\r\nc\r\n', 'a\r\nB\r\nc\r\n', '@@ -1,3 +1,3 @@\n a\r\n-b\r\n+B\r\n c\r\n'],
      ['a\r\nb\r\n', 'a\nb\n', '@@ -1,2 +1,2 @@\n-a\r\n-b\r\n+a\n+b\n'],
      ['a\r\nb', 'a\r\nb\r\n', `@@ -1,2 +1,2 @@\n a\r\n-b\n${NO_EOL}+b\r\n`],
      ['only', '', `@@ -1 +0,0 @@\n-only\n${NO_EOL}`],
      [
        '1\n2\n3\n4\n5\n6\n7\n8\n9\n10\n11\n12\n13\n14\n15\n16\n17\n18\n19\n20',
        '1\nTWO\n3\n4\n5\n6\n7\n8\n9\n10\n11\n12\n13\n14\n15\n16\n17\n18\n19\n20',
        '@@ -1,5 +1,5 @@\n 1\n-2\n+TWO\n 3\n 4\n 5\n',
      ],
      ['1\n2\n3\n4\n5\n6\n7\n8\n9\n10', '1\n2\n3\n4\n5\n6\n7\nEIGHT\n9\n10', `@@ -5,6 +5,6 @@\n 5\n 6\n 7\n-8\n+EIGHT\n 9\n 10\n${NO_EOL}`],
      ['1\n2\n3\n4\n5\n6\n7\n8\n9\n10', '1\n2\n3\n4\n5\n6\n7\n8\n9\n10\n', `@@ -7,4 +7,4 @@\n 7\n 8\n 9\n-10\n${NO_EOL}+10\n`],
      ['a\r\nb\r\nc', 'a\r\nb\r\nc\r\nd', `@@ -1,3 +1,4 @@\n a\r\n b\r\n-c\n${NO_EOL}+c\r\n+d\n${NO_EOL}`],
    ];
    const t = await makeTestRepo();
    for (const [k, [old]] of cases.entries()) await t.write(`f${k}`, old);
    await t.commit('Base');
    for (const [k, [, now]] of cases.entries()) await t.write(`f${k}`, now);
    for (const [k, [, , git]] of cases.entries()) expect(render(await wipDiff(t.repo, t.dir, `f${k}`, false)), `case ${k}`).toBe(git);
    // Staged, the same hunks come from the index's blobs.
    await t.stage('f0');
    expect(render(await wipDiff(t.repo, t.dir, 'f0', true))).toBe(cases[0][2]);
    expect(render(await wipDiff(t.repo, t.dir, 'f0', false))).toBe('');
  });

  it('refuses folders, missing paths, conflicts, LFS, binaries, links and type changes', async () => {
    const t = await makeTestRepo();
    await t.write('.gitattributes', '*.csv filter=lfs diff=lfs merge=lfs -text\n*.dat -diff\n');
    await t.write('d/a', 'x\n');
    await t.write('f', 'one\n');
    await t.write('b.bin', new Uint8Array([0, 1, 2]));
    await t.link('l', 'old');
    await t.write('c.txt', 'base\n');
    await t.write('gone.txt', 'gone\n');
    await t.commit('Base');
    for (const staged of [false, true]) await expect(wipDiff(t.repo, t.dir, 'd', staged)).rejects.toMatchObject({ kind: 'InvalidInput', message: 'd is not a file' });
    await expect(wipDiff(t.repo, t.dir, 'nowhere.txt', false)).rejects.toMatchObject({ kind: 'NotFound', message: 'nowhere.txt not found' });
    await t.write('data.csv', 'a,b\n');
    expect(await wipDiff(t.repo, t.dir, 'data.csv', false)).toBe(LFS_WHOLE);
    await t.write('b.bin', new Uint8Array([0, 1, 3]));
    expect(await wipDiff(t.repo, t.dir, 'b.bin', false)).toBe(BINARY);
    await t.write('notes.dat', 'plain text\n');
    expect(await wipDiff(t.repo, t.dir, 'notes.dat', false)).toBe(BINARY);
    await t.remove('l');
    await t.link('l', 'new');
    expect(await wipDiff(t.repo, t.dir, 'l', false)).toBe(SYMLINK);
    await t.link('nl', 'target');
    expect(await wipDiff(t.repo, t.dir, 'nl', false)).toBe(SYMLINK);
    await t.remove('f');
    await t.link('f', 'target');
    expect(await wipDiff(t.repo, t.dir, 'f', false)).toBe(TYPECHANGE);
    await t.stage('f');
    expect(await wipDiff(t.repo, t.dir, 'f', true)).toBe(TYPECHANGE);
    // In HEAD only, gone from the index and the worktree: the core's `--no-index` diff can't read it.
    await t.remove('gone.txt');
    await t.stage('gone.txt');
    await expect(wipDiff(t.repo, t.dir, 'gone.txt', false)).rejects.toMatchObject({ kind: 'Other', message: "Could not access 'gone.txt'" });
    expect(hunksOf(await wipDiff(t.repo, t.dir, 'gone.txt', true))).toEqual([{ oldStart: 1, oldLines: 1, newStart: 0, newLines: 0, del: [1], add: [] }]);
    const entries = (await readIndex(t.repo, t.repo.gitdir)).filter((e) => e.path !== 'c.txt');
    const oid = '1'.repeat(40);
    await setIndex(t, [...entries, { path: 'c.txt', mode: MODE_FILE, oid, stage: 2 }, { path: 'c.txt', mode: MODE_FILE, oid, stage: 3 }]);
    expect(await wipDiff(t.repo, t.dir, 'c.txt', false)).toBe(CONFLICTED);
    expect(await wipDiff(t.repo, t.dir, 'c.txt', true)).toBe(CONFLICTED);
  });

  it("refuses a submodule's new commit, its removal and a dirty checkout at the recorded commit", async () => {
    const t = await makeTestRepo();
    await t.write('a.txt', 'a\n');
    await t.commit('Base');
    const head = await writeNested(t, 'sm', 'sm', { 's.txt': 's\n' });
    t.memfs.mkdirpSync(`${t.dir}/empty`);
    await t.write('file', 'file\n');
    const link = (path: string, oid: string) => ({ path, mode: MODE_GITLINK, oid, stage: 0 });
    const entries = (await readIndex(t.repo, t.repo.gitdir)).filter((e) => e.path !== 'file');
    await setIndex(t, [...entries, link('empty', head), link('file', head), link('gone', head), link('sm', head)]);
    expect(hunksOf(await wipDiff(t.repo, t.dir, 'sm', false))).toEqual([]);
    expect(hunksOf(await wipDiff(t.repo, t.dir, 'empty', false))).toEqual([]); // not checked out: no change
    expect(await wipDiff(t.repo, t.dir, 'gone', false)).toBe(SUBMODULE); // `deleted file mode 160000`
    expect(await wipDiff(t.repo, t.dir, 'file', false)).toBe(TYPECHANGE);
    expect(await wipDiff(t.repo, t.dir, 'sm', true)).toBe(SUBMODULE); // a new gitlink, staged
    // A dirty checkout at the recorded commit: git's diff has no `index` line, but its `Subproject commit`
    // lines still make it a whole-file change (the core's a_dirty_submodule_at_its_recorded_commit_is_refused).
    await t.write('sm/s.txt', 's2\n');
    expect(await wipDiff(t.repo, t.dir, 'sm', false)).toBe(SUBMODULE);
    // A file whose text has such a line is still a file: its diff names its mode.
    await t.write('a.txt', `Subproject commit ${head}\n`);
    expect(render(await wipDiff(t.repo, t.dir, 'a.txt', false))).toBe(`@@ -1 +1 @@\n-a\n+Subproject commit ${head}\n`);
    await setIndex(t, [...entries, link('sm', '2'.repeat(40))]);
    expect(await wipDiff(t.repo, t.dir, 'sm', false)).toBe(SUBMODULE);
  });

  it('has no hunks for a mode-only change, and none past the size cap', async () => {
    const t = await makeTestRepo();
    await t.write('run.sh', 'echo\n');
    await t.commit('Base');
    await t.write('run.sh', 'echo\n', { exec: true });
    expect(hunksOf(await wipDiff(t.repo, t.dir, 'run.sh', false))).toEqual([]);
    await t.write('big.txt', 'line\n'.repeat((5 * 1024 * 1024) / 5 + 1));
    expect(await wipDiff(t.repo, t.dir, 'big.txt', false)).toBe(TOO_LARGE);
  });

  it("measures git's diff text when the worktree file isn't over the cap", async () => {
    const t = await makeTestRepo();
    const line = 'y'.repeat(4095) + '\n';
    await t.write('four.txt', line.repeat(1024)); // 4 MiB
    await t.write('swap', line.repeat(1536)); // 6 MiB
    await t.commit('Base');
    // Staged, no worktree file is measured: git's diff of 6 MiB passes the cap.
    await t.write('six.txt', line.repeat(1536));
    await t.stage('six.txt');
    expect(await wipDiff(t.repo, t.dir, 'six.txt', true)).toBe(TOO_LARGE);
    // Replaced by a link: the worktree side is no file, and git's text (the whole old file) is checked
    // before the type change is.
    await t.remove('swap');
    await t.link('swap', 'four.txt');
    expect(await wipDiff(t.repo, t.dir, 'swap', false)).toBe(TOO_LARGE);
    // Under the cap: hunks.
    await t.write('four.txt', line.repeat(1024) + 'end\n');
    expect(hunksOf(await wipDiff(t.repo, t.dir, 'four.txt', false))).toEqual([{ oldStart: 1022, oldLines: 3, newStart: 1022, newLines: 4, del: [], add: [1025] }]);
  });
});
