import * as git from 'isomorphic-git';
import { describe, expect, it } from 'vitest';
import { DateQueue, followLog, messageLog, pathLog } from './logWalk';
import { makeTestRepo, mergeRepo, storyRepo, type TestRepo } from './testkit';

/** Commits what's staged with this committer time (the kit's own clock only goes forward). */
async function commitAt(t: TestRepo, message: string, time: number, parents?: string[]): Promise<string> {
  const sig = { name: 'Ada Lovelace', email: 'ada@example.com', timestamp: time, timezoneOffset: 0 };
  return git.commit({ fs: t.memfs, dir: t.dir, message, author: sig, committer: sig, parent: parents });
}

const summaries = async (t: TestRepo, ids: string[]) => Promise.all(ids.map(async (id) => (await git.readCommit({ fs: t.memfs, dir: t.dir, oid: id })).commit.message.trim()));

describe('log walks', () => {
  it('pops newest first, ties in queue order', () => {
    const q = new DateQueue<string>();
    q.push('a', 10);
    q.push('b', 30);
    q.push('c', 30);
    q.push('d', 20);
    expect(q.size).toBe(4);
    expect([q.pop(), q.pop(), q.pop(), q.pop(), q.pop()]).toEqual(['b', 'c', 'd', 'a', undefined]);
  });

  it("follows a file through its rename, with each row's path", async () => {
    const { t, head } = await storyRepo();
    const rows = await followLog(t.repo, head, 'src/story.txt', 100);
    expect(rows.map((r) => [r.summary, r.path, r.status, r.oldPath])).toEqual([
      ['Sharpen the opening', 'src/story.txt', 'M', null],
      ['Move the story under src', 'src/story.txt', 'R', 'story.txt'],
      ['Add the middle', 'story.txt', 'M', null],
      ['Start the story', 'story.txt', 'A', null],
    ]);
    expect(rows[0]).toMatchObject({ author: 'Ada Lovelace', email: 'ada@example.com' });
    expect(rows[3].parents).toEqual([]);
    expect(rows[2].parents).toHaveLength(1);
    expect((await followLog(t.repo, head, 'src/story.txt', 2)).length).toBe(2);
  });

  it('starts where it is asked to', async () => {
    const { t, middle } = await storyRepo();
    expect((await followLog(t.repo, middle, 'story.txt', 100)).map((r) => r.summary)).toEqual(['Add the middle', 'Start the story']);
  });

  it('never lists a merge, even one that resolved the file', async () => {
    const { t, base, main, side, merge } = await mergeRepo();
    expect((await followLog(t.repo, merge, 'f', 100)).map((r) => r.summary)).toEqual(['side edits f', 'edit f', 'add f']);
    expect(await pathLog(t.repo, [merge], (p) => p === 'f', 100)).toEqual([merge, side, main, base]);
  });

  it('simplifies a pathspec history through merges that changed nothing there', async () => {
    const t = await makeTestRepo();
    await t.write('docs/a.md', 'a\n');
    const base = await t.commit('docs');
    await t.write('code.rs', 'fn x() {}\n');
    const main = await t.commit('code on main');
    await t.branch('side', base);
    await t.checkout('side');
    await t.write('docs/a.md', 'a\nb\n');
    const side = await t.commit('docs on side');
    await t.checkout('main');
    await t.write('docs/a.md', 'a\nb\n');
    const merge = await t.commit('Merge side', undefined, { parents: [main, side] });
    // TREESAME to `side` for docs: the merge isn't listed and only `side` is followed, so `main` (no docs change) is never reached.
    expect(await pathLog(t.repo, [merge], (p) => p.startsWith('docs/'), 100)).toEqual([side, base]);
    expect(await pathLog(t.repo, [merge], (p) => p === 'code.rs', 100)).toEqual([main]);
  });

  it('--follow walks every parent, where a pathspec takes the first TREESAME one', async () => {
    const t = await makeTestRepo();
    await t.write('f', 'a\n');
    await t.write('g', 'x\n');
    const base = await t.commit('add f');
    await t.write('g', 'y\n');
    const main = await t.commit('main g');
    await t.branch('side', base);
    await t.checkout('side');
    await t.write('f', 'a\nz\n');
    await t.commit('side z');
    await t.write('f', 'a\n');
    const side = await t.commit('side unz');
    await t.checkout('main');
    await t.write('f', 'a\n');
    const merge = await t.commit('Merge side', undefined, { parents: [main, side] });
    expect((await followLog(t.repo, merge, 'f', 100)).map((r) => r.summary)).toEqual(['side unz', 'side z', 'add f']);
    expect(await pathLog(t.repo, [merge], (p) => p === 'f', 100)).toEqual([base]);
  });

  it('pairs the followed path with a deleted file even when another added file takes it under -M', async () => {
    const t = await makeTestRepo();
    const fifty = Array.from({ length: 50 }, (_, i) => `${i + 1}\n`);
    await t.write('a.txt', fifty.join(''));
    await t.commit('start');
    await t.remove('a.txt');
    await t.write('b.txt', fifty.join(''));
    await t.write('c.txt', `${fifty.slice(0, 45).join('')}x\ny\n`);
    const head = await t.commit('move');
    // `git show -M` says b.txt is the rename (exact) and c.txt an add; --follow c.txt still finds a.txt.
    expect((await followLog(t.repo, head, 'c.txt', 100)).map((r) => [r.summary, r.status, r.path, r.oldPath])).toEqual([
      ['move', 'R', 'c.txt', 'a.txt'],
      ['start', 'A', 'a.txt', null],
    ]);
  });

  it('lists deletions, re-additions and type changes, and no rename from a symlink', async () => {
    const t = await makeTestRepo();
    const twenty = Array.from({ length: 20 }, (_, i) => `${i + 1}\n`).join('');
    await t.write('f', twenty);
    await t.commit('add1');
    await t.remove('f');
    await t.commit('del');
    await t.write('f', `${twenty}x\n`);
    await t.commit('readd');
    await t.remove('f');
    await t.link('f', 'target');
    await t.commit('tolink');
    await t.remove('f');
    await t.write('g', twenty);
    const head = await t.commit('remove link add g');
    expect((await followLog(t.repo, head, 'f', 100)).map((r) => [r.summary, r.status])).toEqual([
      ['remove link add g', 'D'],
      ['tolink', 'T'],
      ['readd', 'A'],
      ['del', 'D'],
      ['add1', 'A'],
    ]);
    expect((await followLog(t.repo, head, 'g', 100)).map((r) => [r.summary, r.status])).toEqual([['remove link add g', 'A']]);
  });

  describe('--follow finds copies when no deleted file is the source', () => {
    const seq = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => `${from + i}\n`).join('');
    /** The followed rows' `[summary, status, path, oldPath]`. */
    const follow = async (t: TestRepo, path: string) => (await followLog(t.repo, await t.rev('HEAD'), path, 100)).map((r) => [r.summary, r.status, r.path, r.oldPath]);
    /** A start commit with `before`, then one that deletes `gone` and writes `after`: the row for `path` there. */
    async function added(before: Record<string, string>, gone: string[], after: Record<string, string>, path: string) {
      const t = await makeTestRepo();
      for (const [p, text] of Object.entries(before)) await t.write(p, text);
      await t.commit('start');
      for (const p of gone) await t.remove(p);
      for (const [p, text] of Object.entries(after)) await t.write(p, text);
      await t.commit('add');
      const [row] = await follow(t, path);
      return [row[1], row[3]];
    }

    it('follows a copy of an unmodified file into its history, and of a modified one as it was', async () => {
      // git: `C098 a.txt c.txt`, then a.txt's own rows.
      const t = await makeTestRepo();
      await t.write('a.txt', seq(1, 50));
      await t.write('other.txt', seq(101, 150));
      await t.commit('start');
      await t.write('a.txt', seq(1, 51));
      await t.commit('edit a');
      await t.write('c.txt', `${seq(1, 51)}x\n`);
      await t.commit('copy a to c');
      await t.remove('c.txt');
      await t.commit('delete c');
      await t.write('c.txt', seq(101, 149));
      await t.commit('re-add c like other');
      expect(await follow(t, 'c.txt')).toEqual([
        ['re-add c like other', 'C', 'c.txt', 'other.txt'],
        ['start', 'A', 'other.txt', null],
      ]);
      await t.remove('c.txt');
      await t.commit('delete c again');
      await t.write('d.txt', `${seq(1, 51)}x\n`);
      await t.commit('copy a to d');
      expect(await follow(t, 'd.txt')).toEqual([
        ['copy a to d', 'C', 'd.txt', 'a.txt'],
        ['edit a', 'M', 'a.txt', null],
        ['start', 'A', 'a.txt', null],
      ]);
      // The source as it was in the parent: a.txt rewritten in the same commit, c.txt its old content (git: C100).
      expect(await added({ 'a.txt': seq(1, 100) }, [], { 'a.txt': seq(500, 600), 'c.txt': seq(1, 100) }, 'c.txt')).toEqual(['C', 'a.txt']);
    });

    it('prefers exact matches, then renames, then copies', async () => {
      const x = `${seq(1, 30)}${seq(200, 219)}`; // 50% like seq(1, 50)
      // An unmodified exact copy beats a 50% rename (git: C100 y.txt) ...
      expect(await added({ 'x.txt': x, 'y.txt': seq(1, 50) }, ['x.txt'], { 'z.txt': seq(1, 50) }, 'z.txt')).toEqual(['C', 'y.txt']);
      // ... but a 50% rename beats a 98% copy (git: R050 x.txt).
      expect(await added({ 'x.txt': x, 'y.txt': seq(1, 50) }, ['x.txt'], { 'z.txt': `${seq(1, 50)}extra\n` }, 'z.txt')).toEqual(['R', 'x.txt']);
      // Exact: the same file name first, a deleted one before a kept one, then path order.
      expect(await added({ 'p.txt': seq(1, 20), 'q.txt': seq(1, 20) }, ['q.txt'], { 'r.txt': seq(1, 20) }, 'r.txt')).toEqual(['R', 'q.txt']);
      expect(await added({ 'a.txt': seq(1, 30), 'b/t.txt': seq(1, 30), 'c.txt': seq(1, 30) }, ['c.txt'], { 't.txt': seq(1, 30) }, 't.txt')).toEqual(['C', 'b/t.txt']);
      expect(await added({ 'a/t.txt': seq(1, 30), 'b/t.txt': seq(1, 30) }, ['b/t.txt'], { 't.txt': seq(1, 30) }, 't.txt')).toEqual(['R', 'b/t.txt']);
      expect(await added({ 'b.txt': seq(1, 50), 'a.txt': seq(1, 50) }, [], { 'c.txt': seq(1, 50) }, 'c.txt')).toEqual(['C', 'a.txt']);
      // Symlinks and empty files copy exactly (git: C100).
      const t = await makeTestRepo();
      await t.link('lnk', 'target');
      await t.write('e1', '');
      await t.commit('start');
      await t.link('lnk2', 'target');
      await t.write('e2', '');
      await t.commit('add');
      expect((await follow(t, 'lnk2'))[0]).toEqual(['add', 'C', 'lnk2', 'lnk']);
      expect((await follow(t, 'e2'))[0]).toEqual(['add', 'C', 'e2', 'e1']);
    });

    it('takes the best score with no unique-name step, ties to the same name then path order', async () => {
      // Plain `-M` pairs sub/f.txt (87%, the only f.txt) first; --follow takes b.txt (93%), as a rename and as a copy.
      const before = { 'sub/f.txt': `${seq(1, 90)}${seq(900, 909)}`, 'b.txt': `${seq(1, 95)}${seq(950, 954)}` };
      expect(await added(before, ['sub/f.txt', 'b.txt'], { 'f.txt': seq(1, 100) }, 'f.txt')).toEqual(['R', 'b.txt']);
      expect(await added(before, [], { 'f.txt': seq(1, 100) }, 'f.txt')).toEqual(['C', 'b.txt']);
      const alike = (tag: string) => `${seq(1, 70)}${seq(800, 829)}${tag}\n`;
      const six = Object.fromEntries(['a', 'b', 'c', 'd', 'e', 'g'].map((n) => [`${n}.txt`, alike(n)]));
      expect(await added(six, [], { 't.txt': seq(1, 100) }, 't.txt')).toEqual(['C', 'a.txt']);
      expect(await added({ ...six, 'z/t.txt': alike('z') }, [], { 't.txt': seq(1, 100) }, 't.txt')).toEqual(['C', 'z/t.txt']);
      expect(await added({ ...six, 'h.txt': `${seq(1, 90)}${seq(800, 809)}` }, [], { 't.txt': seq(1, 100) }, 't.txt')).toEqual(['C', 'h.txt']);
      // Under 50% (git: 43%) it's an add.
      expect(await added({ 'a.txt': seq(1, 100) }, [], { 'c.txt': `${seq(1, 52)}${seq(300, 347)}` }, 'c.txt')).toEqual(['A', null]);
    });
  });

  it('pops by committer time even when a parent is newer than its child, ties in the order queued', async () => {
    const t = await makeTestRepo();
    await t.write('f', 'a\n');
    await t.stage('f');
    const a = await commitAt(t, 'A', 1_700_000_100);
    await t.write('f', 'b\n');
    await t.stage('f');
    const b = await commitAt(t, 'B', 1_700_000_050, [a]);
    await t.write('f', 'c\n');
    await t.stage('f');
    const c = await commitAt(t, 'C', 1_700_000_200, [b]);
    await t.write('f', 'd\n');
    await t.stage('f');
    const d = await commitAt(t, 'D', 1_700_000_150, [a]);
    const all = () => true;
    // As `git log C D`: A (100) comes out before its child B (50).
    expect(await summaries(t, await messageLog(t.repo, [c, d], '', 100))).toEqual(['C', 'D', 'A', 'B']);
    expect(await summaries(t, await pathLog(t.repo, [c, d], all, 100))).toEqual(['C', 'D', 'A', 'B']);
    expect((await followLog(t.repo, c, 'f', 100)).map((r) => r.summary)).toEqual(['C', 'B', 'A']);

    // Equal times: `git log Y M` gives Y M R X, `git log M Y` gives M Y X R.
    const r = await commitAt(t, 'R', 1_700_000_000, []);
    const x = await commitAt(t, 'X', 1_700_000_000, [r]);
    const y = await commitAt(t, 'Y', 1_700_000_000, [r]);
    const m = await commitAt(t, 'M', 1_700_000_000, [x, y]);
    expect(await summaries(t, await messageLog(t.repo, [y, m], '', 100))).toEqual(['Y', 'M', 'R', 'X']);
    expect(await summaries(t, await messageLog(t.repo, [m, y], '', 100))).toEqual(['M', 'Y', 'X', 'R']);
  });

  it('greps messages case-insensitively, ASCII only', async () => {
    const { t, head } = await storyRepo();
    expect((await messageLog(t.repo, [head], 'STORY', 100)).length).toBe(2);
    expect(await messageLog(t.repo, [head], 'story', 1)).toHaveLength(1);
    expect(await messageLog(t.repo, [head], 'Ada', 100)).toEqual([]); // the author line isn't searched

    await t.write('u.txt', 'u\n');
    const u = await t.commit('Ünïcode here\n\nThe body has a Twist');
    expect(await messageLog(t.repo, [u], 'twist', 100)).toEqual([u]);
    // git -i under LC_ALL=C (as the core runs it) folds ASCII letters only.
    expect(await messageLog(t.repo, [u], 'ÜNï', 100)).toEqual([u]);
    expect(await messageLog(t.repo, [u], 'ÜNÏ', 100)).toEqual([]);
    expect(await messageLog(t.repo, [u], 'ünï', 100)).toEqual([]);
  });
});
