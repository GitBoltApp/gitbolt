import { describe, expect, it } from 'vitest';
import { mergeIsClean, predictConflicts } from './merge3';
import { makeTestRepo, type TestRepo } from './testkit';
import { latin1 } from './bytes';
import { listFiles, MODE_EXEC, MODE_LINK, readBlobBytes } from './trees';

const L = (...xs: string[]) => xs.map((x) => `${x}\n`);

describe('three-way merge', () => {
  it('merges separate changes, refuses touching or overlapping different ones', () => {
    const base = L('a', 'b', 'c', 'd');
    expect(mergeIsClean(base, L('a', 'B', 'c', 'd'), L('a', 'b', 'C', 'd'))).toBe(false);
    expect(mergeIsClean(base, L('a', 'B', 'c', 'd'), L('a', 'b', 'c', 'D'))).toBe(true);
    expect(mergeIsClean(base, L('a', 'X', 'b', 'c', 'd'), L('a', 'b', 'Y', 'c', 'd'))).toBe(true);
    expect(mergeIsClean(base, L('a', 'X', 'b', 'c', 'd'), L('a', 'Y', 'b', 'c', 'd'))).toBe(false);
    expect(mergeIsClean(base, L('a', 'B', 'c', 'd'), L('a', 'B', 'c', 'd'))).toBe(true);
    expect(mergeIsClean([], L('x'), L('y'))).toBe(false);
  });

  it('takes deletions, insertions and changes that touch as one group', () => {
    const base = L('a', 'b', 'c', 'd');
    expect(mergeIsClean(base, L('a', 'c', 'd'), L('a', 'b', 'd'))).toBe(false);
    expect(mergeIsClean(base, L('a', 'c', 'd'), L('a', 'c', 'd'))).toBe(true);
    expect(mergeIsClean(base, L('a', 'b', 'X', 'c', 'd'), L('a', 'b', 'C', 'd'))).toBe(false);
    expect(mergeIsClean(base, L('a', 'B', 'c', 'd'), L('a', 'B', 'C', 'd'))).toBe(false);
    expect(mergeIsClean(L('a', 'b\r', 'c'), L('a', 'B\r', 'c'), L('a', 'b\r', 'C'))).toBe(false);
  });

  it('predicts the paths a merge of two commits would leave unresolved', async () => {
    const t = await makeTestRepo();
    await t.write('both.txt', 'a\nb\nc\nd\n');
    await t.write('clean.txt', 'a\nb\nc\nd\n');
    await t.write('gone.txt', 'keep\n');
    await t.write('moved.txt', 'one\ntwo\nthree\nfour\nfive\nsix\n');
    const base = await t.commit('Base');
    await t.write('both.txt', 'a\nOURS\nc\nd\n');
    await t.write('clean.txt', 'A\nb\nc\nd\n');
    await t.write('gone.txt', 'edited\n');
    await t.remove('moved.txt');
    await t.write('docs/moved.txt', 'one\ntwo\nthree\nfour\nfive\nsix\n');
    const ours = await t.commit('Ours');
    await t.branch('theirs', base);
    await t.checkout('theirs');
    await t.write('both.txt', 'a\nTHEIRS\nc\nd\n');
    await t.write('clean.txt', 'a\nb\nc\nD\n');
    await t.remove('gone.txt');
    await t.write('moved.txt', 'one\ntwo\nthree\nfour\nfive\nsix\nseven\n');
    await t.write('new.txt', 'theirs\n');
    const theirs = await t.commit('Theirs');
    expect(await predictConflicts(t.repo, ours, theirs)).toEqual(['both.txt', 'gone.txt']);
    expect(await predictConflicts(t.repo, base, ours)).toEqual([]);
  });
});

/** The worktree back at `commit`'s files, HEAD on `branch` (isomorphic-git's checkout can't replace a
 *  folder with a file, or a symlink). */
async function restore(t: TestRepo, commit: string, branch: string) {
  const wipe = (dir: string) => {
    for (const name of t.memfs.readdirSync(dir)) {
      const path = `${dir}/${name}`;
      if (path === `${t.dir}/.git`) continue;
      if (t.memfs.lstatSync(path).isDirectory()) {
        wipe(path);
        t.memfs.rmdirSync(path);
      } else t.memfs.unlinkSync(path);
    }
  };
  wipe(t.dir);
  for (const [path, e] of await listFiles(t.repo, commit)) {
    const bytes = await readBlobBytes(t.repo, e.oid);
    if (e.mode === MODE_LINK) await t.link(path, latin1(bytes));
    else await t.write(path, bytes, { exec: e.mode === MODE_EXEC });
  }
  await t.branch(branch, commit);
  t.memfs.writeFileSync(`${t.repo.gitdir}/HEAD`, `ref: refs/heads/${branch}\n`);
}

type Step = (t: TestRepo) => Promise<unknown>;

/** A base commit, then `ours` on main and `theirs` on a branch from the base; each step edits the worktree. */
async function sides(base: Step, ours: Step, theirs: Step) {
  const t = await makeTestRepo();
  await t.write('keep.txt', 'keep\n');
  await base(t);
  const b = await t.commit('Base');
  await ours(t);
  const o = await t.commit('Ours');
  await restore(t, b, 'theirs');
  await theirs(t);
  const th = await t.commit('Theirs');
  return predictConflicts(t.repo, o, th);
}

const TEXT = L('one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight');
const edited = (n: number, to: string) => TEXT.map((l, i) => (i === n ? `${to}\n` : l)).join('');

describe('conflicts as the core counts them', () => {
  it('a rename against a deletion, or renamed apart, is reported at ours\' path', async () => {
    const f = (t: TestRepo) => t.write('f.txt', TEXT.join(''));
    const mv = (to: string) => async (t: TestRepo) => {
      await t.remove('f.txt');
      await t.write(to, TEXT.join(''));
    };
    expect(await sides(f, mv('g.txt'), (t) => t.remove('f.txt'))).toEqual(['g.txt']);
    expect(await sides(f, (t) => t.remove('f.txt'), mv('g.txt'))).toEqual(['f.txt']);
    expect(await sides(f, mv('g.txt'), mv('h.txt'))).toEqual(['g.txt']);
    expect(await sides(f, mv('g.txt'), (t) => t.write('f.txt', edited(1, 'TWO')))).toEqual([]);
    expect(await sides(f, (t) => t.write('f.txt', edited(1, 'O')), async (t) => {
          await mv('g.txt')(t);
          await t.write('g.txt', edited(1, 'T'));
        })).toEqual(['f.txt']);
  });

  it('two files added at one path, or a file where the other side adds to a folder', async () => {
    const none = async () => {};
    expect(await sides(none, (t) => t.write('n.txt', 'ours\n'), (t) => t.write('n.txt', 'theirs\n'))).toEqual(['n.txt']);
    expect(await sides(none, (t) => t.write('n.txt', 'same\n'), (t) => t.write('n.txt', 'same\n'))).toEqual([]);
    expect(await sides(none, (t) => t.write('n.txt', 'same\n', { exec: true }), (t) => t.write('n.txt', 'same\n'))).toEqual(['n.txt']);
    expect(await sides(none, (t) => t.write('d', 'file\n'), (t) => t.write('d/x.txt', 'x\n'))).toEqual(['d']);
    const dir = (t: TestRepo) => t.write('d/x.txt', TEXT.join(''));
    const toFile = async (t: TestRepo) => {
      await t.remove('d/x.txt');
      t.memfs.rmdirSync(`${t.dir}/d`);
      await t.write('d', 'file\n');
    };
    expect(await sides(dir, (t) => t.write('keep.txt', 'kept\n'), toFile)).toEqual([]);
    expect(await sides(dir, (t) => t.write('d/x.txt', edited(1, 'O')), toFile)).toEqual(['d', 'd/x.txt']);
    expect(await sides(dir, toFile, (t) => t.write('d/y.txt', 'y\n'))).toEqual(['d']);
    // Renamed onto a folder the other side adds to: the core moves the file aside (git would conflict).
    const moveTo = (to: string, text = TEXT.join('')) => async (t: TestRepo) => {
      await t.remove('f.txt');
      await t.write(to, text);
    };
    const f = (t: TestRepo) => t.write('f.txt', TEXT.join(''));
    expect(await sides(f, moveTo('g'), (t) => t.write('g/x.txt', 'x\n'))).toEqual([]);
    expect(await sides(f, (t) => t.write('g/x.txt', 'x\n'), moveTo('g', edited(1, 'T')))).toEqual([]);
  });

  it('binary files, symlinks and modes', async () => {
    const bin = (s: string) => new TextEncoder().encode(`\0${s}\n`);
    const b = (t: TestRepo) => t.write('b.bin', bin('base'));
    expect(await sides(b, (t) => t.write('b.bin', bin('ours')), (t) => t.write('b.bin', bin('theirs')))).toEqual(['b.bin']);
    expect(await sides(b, (t) => t.write('b.bin', bin('base'), { exec: true }), (t) => t.write('b.bin', bin('theirs')))).toEqual(['b.bin']);
    const f = (t: TestRepo) => t.write('f.txt', TEXT.join(''));
    expect(await sides(f, (t) => t.write('f.txt', TEXT.join(''), { exec: true }), (t) => t.write('f.txt', edited(1, 'T')))).toEqual([]);
    const l = (t: TestRepo) => t.link('l', 'one');
    const relink = (to: string) => async (t: TestRepo) => {
      await t.remove('l');
      await t.link('l', to);
    };
    expect(await sides(l, relink('two'), relink('three'))).toEqual(['l']);
    expect(await sides(l, relink('two'), (t) => t.write('keep.txt', 'kept\n'))).toEqual([]);
  });

  it('an empty file never pairs as a rename', async () => {
    const e = (t: TestRepo) => t.write('e.txt', '');
    const mv = async (t: TestRepo) => {
      await t.remove('e.txt');
      await t.write('e2.txt', '');
    };
    expect(await sides(e, mv, (t) => t.write('e.txt', 'full\n'))).toEqual(['e.txt']);
  });

  it('predicts nothing without a merge base', async () => {
    const t = await makeTestRepo();
    await t.write('f.txt', 'one\n');
    const a = await t.commit('A');
    await t.write('f.txt', 'two\n');
    const b = await t.commit('B', undefined, { parents: [] });
    expect(await predictConflicts(t.repo, a, b)).toEqual([]);
  });
});
