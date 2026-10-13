import * as git from 'isomorphic-git';
import { describe, expect, it, vi } from 'vitest';
import type { FileChange } from '../../../api/gen/FileChange';
import { MODE_FILE, MODE_GITLINK } from './trees';
import { countLines, pairImageConversions, totals, treeChanges, wipStaged, wipUnstaged, worktreeChanges } from './changes';
import { readIndex, serializeIndex } from './indexFile';
import type { ReadRepo } from './seam';
import { worktreeFile } from './worktree';
import { addWorktree, makeTestRepo, setIndex, writeNested, type TestRepo } from './testkit';

const rows = (fs: FileChange[]) => fs.map((f) => [f.path, f.status, f.additions, f.deletions]);
const guide = (extra = '') => `Guide\n\nStep one.\nStep two${extra}.\nStep three.\nStep five.\nStep six.\nStep seven.\nStep eight.\n`;
const storeBlob = (t: TestRepo, text: string) => git.writeBlob({ fs: t.memfs, gitdir: t.repo.gitdir, blob: new TextEncoder().encode(text) });

async function detailsLike() {
  const t = await makeTestRepo();
  await t.write('docs/guide.txt', guide());
  await t.write('data.bin', new Uint8Array([0x42, 0, 1, 2]));
  await t.write('old.txt', 'to be deleted\n');
  await t.write('logo.png', new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0]));
  const root = await t.commit('Initial commit');
  await t.remove('docs/guide.txt');
  await t.write('docs/manual.txt', guide(', revised'));
  await t.write('data.bin', new Uint8Array([0x42, 0, 1, 3, 4]));
  await t.remove('old.txt');
  await t.write('dir with space/ünï.txt', 'unicode path\n');
  await t.write('b.txt', 'b\n');
  const rename = await t.commit('Rename guide');
  return { t, root, rename };
}

describe('changed-file lists', () => {
  it('lists a commit with renames, binaries and non-ASCII paths in bytewise order', async () => {
    const { t, root, rename } = await detailsLike();
    const list = await treeChanges(t.repo, root, rename);
    expect(rows(list)).toEqual([
      ['b.txt', 'A', 1, 0],
      ['data.bin', 'M', null, null],
      ['dir with space/ünï.txt', 'A', 1, 0],
      ['docs/manual.txt', 'R', 1, 1],
      ['old.txt', 'D', 0, 1],
    ]);
    const r = list.find((f) => f.status === 'R')!;
    expect(r.oldPath).toBe('docs/guide.txt');
    expect(r.old).toMatchObject({ kind: 'object' });
    expect(list.find((f) => f.path === 'old.txt')!.new).toEqual({ kind: 'absent' });
    expect(rows(await treeChanges(t.repo, null, root)).map((x) => x[1])).toEqual(['A', 'A', 'A', 'A']);
  });

  it('counts binaries as git does, even unchanged ones, and marks type changes', async () => {
    const t = await makeTestRepo();
    const bin = new Uint8Array([0x62, 0, 0x78, 10]);
    await t.write('a.bin', bin);
    await t.write('m.bin', new Uint8Array([0x62, 0, 0x79, 10]));
    await t.write('t.txt', 'text\n');
    await t.write('run.sh', 'x\n');
    await t.write('ln', 'a\n');
    await t.write('.gitattributes', '*.dat -diff\n');
    await t.write('x.dat', 'dat\n');
    const base = await t.commit('Base');
    await t.remove('a.bin');
    await t.write('b.bin', bin);
    await t.write('m.bin', new Uint8Array([0x62, 0, 0x79, 10]), { exec: true });
    await t.remove('t.txt');
    await t.write('u.txt', 'text\n');
    await t.write('run.sh', 'x\n', { exec: true });
    await t.remove('ln');
    await t.link('ln', 'a');
    await t.write('x.dat', 'dat2\n');
    const two = await t.commit('Two');
    // As `git diff-tree -r -M --numstat` gives them (checked against git 2.53).
    expect(rows(await treeChanges(t.repo, base, two))).toEqual([
      ['b.bin', 'R', null, null],
      ['ln', 'T', 1, 1],
      ['m.bin', 'M', null, null],
      ['run.sh', 'M', 0, 0],
      ['u.txt', 'R', 0, 0],
      ['x.dat', 'M', null, null],
    ]);
  });

  it("reads only the tracked files git's stat check can't vouch for", async () => {
    const t = await makeTestRepo();
    for (const f of ['a.txt', 'b.txt', 'c.txt']) await t.write(f, `${f}\n`);
    await t.commit('Base');
    await t.write('b.txt', 'B.txt\n');
    const read = vi.spyOn(t.memfs.promises, 'readFile');
    expect(rows(await wipUnstaged(t.repo, t.dir))).toEqual([['b.txt', 'M', 1, 1]]);
    expect((await worktreeChanges(t.repo, t.dir, await t.rev('HEAD'))).map((f) => f.path)).toEqual(['b.txt']);
    const tracked = read.mock.calls.map(([p]) => p).filter((p) => /\/[abc]\.txt$/.test(p));
    expect(new Set(tracked)).toEqual(new Set([`${t.dir}/b.txt`]));
  });

  it('hashes a racily clean file: one whose stat matches the index, but not older than the index', async () => {
    const t = await makeTestRepo();
    await t.write('a.txt', 'one\n');
    await t.commit('Base');
    await t.write('a.txt', 'two\n');
    // The index records the edited file's stat beside the old blob, as a refresh in the same tick as the edit would.
    const st = t.memfs.lstatSync(`${t.dir}/a.txt`);
    const [entry] = await readIndex(t.repo, t.repo.gitdir);
    const bytes = await serializeIndex([entry]);
    const v = new DataView(bytes.buffer);
    v.setUint32(12 + 8, Math.floor(st.mtimeMs / 1000));
    v.setUint32(12 + 12, (st.mtimeMs % 1000) * 1e6);
    v.setUint32(12 + 20, st.ino);
    v.setUint32(12 + 36, st.size);
    t.memfs.writeFileSync(`${t.repo.gitdir}/index`, bytes);
    const withIndexAt = (mtimeMs: number): ReadRepo => {
      const lstat = async (p: string) => (p === `${t.repo.gitdir}/index` ? { ...t.memfs.lstatSync(p), mtimeMs } : t.memfs.lstatSync(p));
      return { ...t.repo, fs: { promises: { ...t.memfs.promises, lstat } } as unknown as ReadRepo['fs'] };
    };
    expect(rows(await wipUnstaged(withIndexAt(st.mtimeMs), t.dir))).toEqual([['a.txt', 'M', 1, 1]]);
    // An index written after the edit vouches for it, as in git: the stat check alone decides.
    expect(rows(await wipUnstaged(withIndexAt(st.mtimeMs + 1000), t.dir))).toEqual([]);
  });

  it('lists WIP staged, unstaged and untracked as git does', async () => {
    const t = await makeTestRepo();
    await t.write('src/app.txt', 'one\ntwo\n');
    await t.write('notes.txt', 'n\n');
    await t.write('gone.txt', 'bye\n');
    await t.commit('Base');
    await t.write('src/app.txt', 'one\ntwo\nstaged\n');
    await t.stage('src/app.txt');
    await t.write('src/app.txt', 'one\ntwo\nstaged\nunstaged\n');
    await t.remove('gone.txt');
    await t.write('new.txt', 'fresh 1\nfresh 2\nfresh 3');
    await t.write('blob.bin', new Uint8Array([0, 1, 2]));
    await t.write('.gitignore', 'build/\n');
    await t.write('build/out.txt', 'ignored\n');
    const staged = await wipStaged(t.repo, t.dir);
    expect(rows(staged)).toEqual([['src/app.txt', 'M', 1, 0]]);
    expect(staged[0].new).toMatchObject({ kind: 'object' });
    const unstaged = await wipUnstaged(t.repo, t.dir);
    expect(rows(unstaged)).toEqual([
      ['.gitignore', 'A', 1, 0],
      ['blob.bin', 'A', null, null],
      ['gone.txt', 'D', 0, 1],
      ['new.txt', 'A', 3, 0],
      ['src/app.txt', 'M', 1, 0],
    ]);
    expect(unstaged.find((f) => f.path === 'src/app.txt')!.new).toEqual({ kind: 'worktree', worktree: t.dir });
    expect(unstaged.find((f) => f.path === 'gone.txt')!.new).toEqual({ kind: 'absent' });
    expect(unstaged.find((f) => f.path === 'new.txt')!.old).toEqual({ kind: 'absent' });
  });

  it("a linked worktree's WIP is its own: its HEAD, its index, its files", async () => {
    const t = await makeTestRepo('basic');
    await t.write('file_0.txt', 'content 0\n');
    await t.commit('Base');
    await t.branch('hotfix');
    await t.write('file_0.txt', 'main 0\n');
    await t.commit('Main edit'); // main's HEAD moves on; hotfix (the linked worktree's HEAD) stays at Base
    const wt = await addWorktree(t, 'hotfix', 'hotfix');
    expect(await wipStaged(t.repo, wt)).toEqual([]);
    t.memfs.writeFileSync(`${wt}/file_0.txt`, 'worktree change\n');
    t.memfs.writeFileSync(`${wt}/scratch.txt`, 'scratch\n');
    const extra = await storeBlob(t, 'extra\n');
    t.memfs.writeFileSync(`${wt}/extra.txt`, 'extra\n');
    const linkedIndex = await readIndex(t.repo, `${t.repo.gitdir}/worktrees/hotfix`);
    await setIndex(t, [...linkedIndex, { path: 'extra.txt', mode: MODE_FILE, oid: extra, stage: 0 }], `${t.repo.gitdir}/worktrees/hotfix`);
    expect(rows(await wipStaged(t.repo, wt))).toEqual([['extra.txt', 'A', 1, 0]]);
    expect(rows(await wipUnstaged(t.repo, wt))).toEqual([
      ['file_0.txt', 'M', 1, 1],
      ['scratch.txt', 'A', 1, 0],
    ]);
    expect((await wipUnstaged(t.repo, wt))[0].new).toEqual({ kind: 'worktree', worktree: wt });
    expect(await wipStaged(t.repo, t.dir)).toEqual([]);
    expect(await wipUnstaged(t.repo, t.dir)).toEqual([]);
  });

  it('marks conflicted paths, once per list, with their kind', async () => {
    const t = await makeTestRepo();
    await t.write('c.txt', 'base\n');
    await t.write('d.txt', 'base\n');
    await t.write('side.txt', 'side\n');
    await t.commit('Base');
    const head = [...(await readIndex(t.repo, t.repo.gitdir))];
    const ours = (await worktreeFile(t.repo, t.dir, 'c.txt'))!.oid;
    const theirs = await storeBlob(t, 'theirs\n');
    await t.write('c.txt', '<<<<<<< HEAD\nbase\n=======\ntheirs\n>>>>>>> other\n');
    await t.write('d.txt', 'theirs\n'); // deleted by us, edited by them: their version is checked out
    const stages = (path: string, ...s: [number, string][]) => s.map(([stage, oid]) => ({ path, mode: MODE_FILE, oid, stage }));
    await setIndex(t, [...head.filter((e) => e.path !== 'c.txt' && e.path !== 'd.txt'), ...stages('c.txt', [1, ours], [2, ours], [3, ours]), ...stages('d.txt', [1, ours], [3, theirs])]);
    const staged = await wipStaged(t.repo, t.dir);
    expect(staged.map((f) => [f.path, f.status, f.additions, f.old.kind, f.new.kind])).toEqual([
      ['c.txt', 'U', 0, 'object', 'absent'],
      ['d.txt', 'U', 0, 'object', 'absent'],
    ]);
    expect(staged[0].conflict).toBeUndefined();
    const unstaged = await wipUnstaged(t.repo, t.dir);
    expect(unstaged.map((f) => [f.path, f.status, f.conflict, f.old.kind, f.new.kind, f.additions, f.deletions])).toEqual([
      ['c.txt', 'U', 'bothModified', 'object', 'worktree', 4, 0],
      // No stage 2, so git compares nothing: `0 0`.
      ['d.txt', 'U', 'deletedByUs', 'absent', 'worktree', 0, 0],
    ]);
    // A deleted file starts git's rename pass, which hashes d.txt's worktree side: a stored blob then.
    await t.remove('side.txt');
    const withDeletion = await wipUnstaged(t.repo, t.dir);
    expect(withDeletion.find((f) => f.path === 'd.txt')!.new).toEqual({ kind: 'object', oid: theirs });
    expect(withDeletion.find((f) => f.path === 'c.txt')!.new).toEqual({ kind: 'worktree', worktree: t.dir });
    // Ours' file gone: the row keeps stage 2 and counts its deletion.
    await t.remove('c.txt');
    expect(rows((await wipUnstaged(t.repo, t.dir)).filter((f) => f.path === 'c.txt'))).toEqual([['c.txt', 'U', 0, 1]]);
  });

  it('compares a commit with the worktree, naming the index blob when the file matches it', async () => {
    const { t, root } = await detailsLike();
    await t.write('b.txt', 'b changed\n');
    await t.write('notes.txt', 'untracked\n'); // untracked files aren't in this list
    let list = await worktreeChanges(t.repo, t.dir, root);
    let by = new Map(list.map((f) => [f.path, f]));
    expect([...by.keys()]).toEqual(['b.txt', 'data.bin', 'dir with space/ünï.txt', 'docs/manual.txt', 'old.txt']);
    expect(by.get('docs/manual.txt')).toMatchObject({ status: 'R', oldPath: 'docs/guide.txt', new: { kind: 'object' } });
    expect(by.get('b.txt')!.new).toEqual({ kind: 'worktree', worktree: t.dir });
    expect(by.get('dir with space/ünï.txt')!.new).toMatchObject({ kind: 'object' });
    // data.bin changed in a later commit and is clean in the worktree: still listed, as the index blob.
    expect(rows([by.get('data.bin')!])).toEqual([['data.bin', 'M', null, null]]);
    expect(by.get('data.bin')!.new).toMatchObject({ kind: 'object' });
    await t.write('data.bin', new Uint8Array([0x42, 0, 9]));
    // An added file whose worktree bytes are a stored blob: git's rename pass hashes it (there's a deletion).
    await t.write('b.txt', 'unicode path\n');
    list = await worktreeChanges(t.repo, t.dir, root);
    by = new Map(list.map((f) => [f.path, f]));
    expect(rows([by.get('data.bin')!])).toEqual([['data.bin', 'M', null, null]]);
    expect(by.get('data.bin')!.new).toEqual({ kind: 'worktree', worktree: t.dir });
    expect(by.get('b.txt')!.new).toEqual(by.get('dir with space/ünï.txt')!.new);
  });

  it('compares an older commit with the worktree, keeping a binary changed since (the core\'s worktree_compare_with_an_older_commit_keeps_a_binary_changed_since)', async () => {
    const t = await makeTestRepo();
    await t.write('f.bin', new Uint8Array([0, 1, ...new TextEncoder().encode('old'), 0]));
    const from = await t.commit('c1');
    await t.write('f.bin', new Uint8Array([0, 1, ...new TextEncoder().encode('newer'), 0]));
    await t.commit('c2');
    expect((await worktreeChanges(t.repo, t.dir, from)).map((f) => f.path)).toEqual(['f.bin']);
  });

  it('gives submodule rows their state', async () => {
    const t = await makeTestRepo();
    await t.write('.gitmodules', '[submodule "parser"]\n\tpath = libs/parser\n');
    await t.write('README.md', 'r\n');
    const base = await t.commit('Base');
    const head = await writeNested(t, 'libs/parser', 'parser', { 'p.txt': 'p\n' });
    const lexer = await writeNested(t, 'libs/lexer', 'lexer', { 'l.txt': 'l\n' });
    const extra = await writeNested(t, 'libs/extra', 'extra', { 'e.txt': 'e\n' });
    t.memfs.mkdirpSync(`${t.dir}/libs/theme`); // never initialised: the empty folder a clone leaves
    const entries = await readIndex(t.repo, t.repo.gitdir);
    const link = (path: string, oid: string) => ({ path, mode: MODE_GITLINK, oid, stage: 0 });
    // The index records another commit for the parser (its checkout has new commits); the lexer and
    // extra are at their recorded commits; the theme was never checked out; `gone`'s folder is missing.
    await setIndex(t, [...entries, link('libs/parser', base), link('libs/lexer', lexer), link('libs/extra', extra), link('libs/theme', base), link('libs/gone', base)]);
    t.memfs.writeFileSync(`${t.dir}/libs/parser/p.txt`, 'edited\n');
    t.memfs.writeFileSync(`${t.dir}/libs/lexer/l.txt`, 'edited\n');
    t.memfs.writeFileSync(`${t.dir}/libs/extra/new.txt`, 'untracked\n');
    // As `git diff` and `git diff --cached` give them: untracked content alone isn't listed, an
    // uninitialised one neither, and the lexer's edits inside stay with its staged new commit.
    let unstaged = await wipUnstaged(t.repo, t.dir);
    expect(rows(unstaged)).toEqual([
      ['libs/gone', 'D', 0, 1],
      ['libs/parser', 'M', 1, 1],
    ]);
    const parser = unstaged.find((f) => f.path === 'libs/parser')!;
    expect(parser).toMatchObject({ submodule: true, old: { kind: 'submodule', oid: base }, new: { kind: 'submodule', oid: head } });
    expect(parser.submoduleState).toEqual({ newCommits: true, modifiedContent: true, untrackedContent: false, uninitialized: false });
    expect(unstaged.find((f) => f.path === 'libs/gone')!.submoduleState).toBeUndefined();
    const staged = await wipStaged(t.repo, t.dir);
    expect(rows(staged).filter(([path]) => path !== '.gitmodules')).toEqual([
      ['libs/extra', 'A', 1, 0],
      ['libs/gone', 'A', 1, 0],
      ['libs/lexer', 'A', 1, 0],
      ['libs/parser', 'A', 1, 0],
      ['libs/theme', 'A', 1, 0],
    ]);
    expect(staged.find((f) => f.path === 'libs/theme')!.submoduleState).toEqual({ newCommits: false, modifiedContent: false, untrackedContent: false, uninitialized: true });
    expect(staged.find((f) => f.path === 'libs/parser')!.submoduleState).toBeUndefined();
    // Once committed, the lexer's edits inside are its only change: `0 0`, at the recorded commit.
    await git.commit({ fs: t.memfs, dir: t.dir, message: 'Add the submodules', author: { name: 'Ada Lovelace', email: 'ada@example.com', timestamp: 1_767_300_000, timezoneOffset: 0 } });
    expect(rows(await wipStaged(t.repo, t.dir))).toEqual([]);
    unstaged = await wipUnstaged(t.repo, t.dir);
    expect(rows(unstaged)).toEqual([
      ['libs/gone', 'D', 0, 1],
      ['libs/lexer', 'M', 0, 0],
      ['libs/parser', 'M', 1, 1],
    ]);
    const lexerRow = unstaged.find((f) => f.path === 'libs/lexer')!;
    expect(lexerRow).toMatchObject({ old: { kind: 'submodule', oid: lexer }, new: { kind: 'submodule', oid: lexer } });
    expect(lexerRow.submoduleState).toEqual({ newCommits: false, modifiedContent: true, untrackedContent: false, uninitialized: false });
  });

  it('pairs an image format change and totals the counts', () => {
    const f = (path: string, status: string, additions: number | null, deletions: number | null): FileChange => ({ path, oldPath: null, status, additions, deletions, old: { kind: 'object', oid: `${path}-old` }, new: { kind: 'object', oid: `${path}-new` }, submodule: false });
    const out = pairImageConversions([f('shot.png', 'D', null, null), f('shot.webp', 'A', null, null), f('a.txt', 'M', 2, 1), f('x/p.png', 'D', null, null), f('y/p.webp', 'A', null, null)]);
    expect(out.map((x) => [x.path, x.status, x.oldPath])).toEqual([['shot.webp', 'R', 'shot.png'], ['a.txt', 'M', null], ['x/p.png', 'D', null], ['y/p.webp', 'A', null]]);
    expect(out[0].old).toEqual({ kind: 'object', oid: 'shot.png-old' });
    expect(totals([f('a.txt', 'M', 2, 1), f('b', 'M', null, null), f('c', 'A', 5, 0)])).toMatchObject({ added: 7, deleted: 1 });
    expect(totals([f('a', 'A', 0xffff_ffff, 0), f('b', 'A', 5, 0)])).toMatchObject({ added: 0xffff_ffff, deleted: 0 });
    expect(totals([])).toEqual({ files: [], added: 0, deleted: 0 });
  });

  it("counts an untracked file's lines like the core", () => {
    const w = (text: string | Uint8Array, mode = MODE_FILE) => {
      const bytes = typeof text === 'string' ? new TextEncoder().encode(text) : text;
      return { mode, bytes, oid: 'x', size: bytes.length };
    };
    expect(countLines(w('a\nb\n'))).toBe(2);
    expect(countLines(w('a\nb'))).toBe(2);
    expect(countLines(w(''))).toBe(0);
    expect(countLines(w(new Uint8Array([1, 0])))).toBeNull();
    expect(countLines(w('target', 0o120000))).toBeNull();
    expect(countLines(w(new Uint8Array(2 * 1024 * 1024 + 1).fill(10)))).toBeNull();
  });

  it('orders non-ASCII paths bytewise', async () => {
    const t = await makeTestRepo();
    await t.write('z.txt', 'z\n');
    await t.write('été.txt', 'e\n');
    await t.write('Z.txt', 'Z\n');
    // U+FF5A sorts before U+1F600 by code point (and UTF-8 bytes), after it by UTF-16 units.
    await t.write('\u{FF5A}.txt', 'fullwidth\n');
    await t.write('\u{1F600}.txt', 'emoji\n');
    const c = await t.commit('Add');
    const order = ['Z.txt', 'z.txt', 'été.txt', '\u{FF5A}.txt', '\u{1F600}.txt'];
    expect((await treeChanges(t.repo, null, c)).map((x) => x.path)).toEqual(order);
    await t.write('z.txt', 'z edited\n');
    await t.write('\u{FF5A}2.txt', 'untracked\n');
    await t.write('\u{1F600}2.txt', 'untracked\n');
    expect((await wipUnstaged(t.repo, t.dir)).map((x) => x.path)).toEqual(['z.txt', '\u{FF5A}2.txt', '\u{1F600}2.txt']);
  });
});
