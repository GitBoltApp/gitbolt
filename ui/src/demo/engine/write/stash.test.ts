import { describe, expect, it } from 'vitest';
import { fixedClock, PARITY_MS } from '../clock';
import { readCommit } from '../read/commitText';
import { makeTestRepo } from '../read/testkit';
import { listFiles, readBlobBytes } from '../read/trees';
import { loadIndex, saveIndex, withEntry } from './index';
import { demoIdent, EMPTY_BLOB, EMPTY_TREE, writeBlobBytes } from './objects';
import { mainWt } from './seam';
import { applyStash, dropStash, patchEntry, pushStash, reflogMessage, stashList, storeStash, subjectOf, userMessage } from './stash';
import { statusEntries } from './status';

const ident = demoIdent(fixedClock(PARITY_MS));

/** HEAD "Base subject": a.txt 1–6, b.txt, c.txt. Local: a.txt +A staged, b.txt +B unstaged, n.txt added, u.txt untracked. */
async function repo() {
  const t = await makeTestRepo();
  await t.write('a.txt', '1\n2\n3\n4\n5\n6\n');
  await t.write('b.txt', 'b\n');
  await t.write('c.txt', 'c\n');
  const head = await t.commit('Base subject');
  const local = async () => {
    await t.write('a.txt', '1\n2\n3\n4\n5\n6\nA\n');
    await t.stage('a.txt');
    await t.write('b.txt', 'b\nB\n');
    await t.write('n.txt', 'new\n');
    await t.stage('n.txt');
    await t.write('u.txt', 'u\n');
  };
  await local();
  return { t, head, wt: mainWt(t.repo), local };
}

const status = async (t: Awaited<ReturnType<typeof repo>>['t']) => (await statusEntries(t.repo, t.dir)).map((e) => `${e.index}${e.worktree} ${e.path}`);

describe('pushStash', () => {
  it("makes git's W, I and U commits, lists the stash, and cleans the worktree", async () => {
    const { t, head, wt } = await repo();
    const s = (await pushStash(wt, ident, 'Fix x', { untracked: 'untracked', paths: null }))!;
    const w = await readCommit(t.repo, s.oid);
    const i = await readCommit(t.repo, w.parents[1]);
    const u = await readCommit(t.repo, w.parents[2]);
    expect([w.parents[0], w.rawMessage, i.rawMessage, u.rawMessage, u.parents]).toEqual([head, 'On main: Fix x', `index on main: ${head.slice(0, 7)} Base subject\n`, `untracked files on main: ${head.slice(0, 7)} Base subject\n`, []]);
    expect([...(await listFiles(t.repo, s.oid)).keys()]).toEqual(['a.txt', 'b.txt', 'c.txt', 'n.txt']);
    expect([...(await listFiles(t.repo, w.parents[2])).keys()]).toEqual(['u.txt']);
    expect([s.subject, stashList(wt), await status(t)]).toEqual(['On main: Fix x', [{ oid: s.oid, subject: 'On main: Fix x' }], []]);
    expect(t.memfs.readFileSync(`${t.repo.gitdir}/logs/refs/stash`, 'utf8')).toBe(`${'0'.repeat(40)} ${s.oid} ${ident}\tOn main: Fix x\n`);
    expect(await pushStash(wt, ident, 'again', { untracked: 'untracked', paths: null })).toBeNull();
  });

  it('lists a multi-line message by its first line, and stashes only the paths named', async () => {
    const { t, wt } = await repo();
    await t.write('v.txt', 'v\n');
    const s = (await pushStash(wt, ident, 'Line one\n\nLine two', { untracked: 'untracked', paths: ['a.txt', 'u.txt'] }))!;
    expect([(await readCommit(t.repo, s.oid)).rawMessage, s.subject]).toEqual(['On main: Line one\n\nLine two', 'On main: Line one']);
    expect([...(await listFiles(t.repo, (await readCommit(t.repo, s.oid)).parents[2])).keys()]).toEqual(['u.txt']);
    expect(await status(t)).toEqual(['.M b.txt', 'A. n.txt', '?? v.txt']);
  });

  it('stashes and applies an awkward path (Review Focus 3)', async () => {
    const { t, wt } = await repo();
    await t.write('dir with space/ünï.txt', 'x\n');
    await t.write('space name.txt', 'y\n');
    await pushStash(wt, ident, 'odd', { untracked: 'untracked', paths: null });
    expect(t.memfs.existsSync(`${t.dir}/dir with space`)).toBe(false);
    const s = stashList(wt)[0];
    expect(await applyStash(wt, s.oid, true)).toEqual({ kind: 'applied' });
    expect(t.memfs.readFileSync(`${t.dir}/dir with space/ünï.txt`, 'utf8')).toBe('x\n');
  });
});

describe('applyStash', () => {
  it('restores the staged split with --index, and stages only new files without it', async () => {
    const { t, wt } = await repo();
    const s = (await pushStash(wt, ident, 's', { untracked: 'untracked', paths: null }))!;
    expect(await applyStash(wt, s.oid, true)).toEqual({ kind: 'applied' });
    expect(await status(t)).toEqual(['M. a.txt', '.M b.txt', 'A. n.txt', '?? u.txt']);
    const { hardReset } = await import('./move');
    await hardReset(wt, (await readCommit(t.repo, s.oid)).parents[0]);
    t.memfs.unlinkSync(`${t.dir}/u.txt`);
    expect(await applyStash(wt, s.oid, false)).toEqual({ kind: 'applied' });
    expect(await status(t)).toEqual(['.M a.txt', '.M b.txt', 'A. n.txt', '?? u.txt']);
  });

  it('conflicts with Updated upstream / Stashed changes markers, the merge left in the index', async () => {
    const { t, wt } = await repo();
    const s = (await pushStash(wt, ident, 's', { untracked: 'none', paths: null }))!;
    await t.write('a.txt', '1\n2\n3\n4\n5\n6\nZ\n');
    await t.commit('Change a');
    expect(await applyStash(wt, s.oid, false)).toEqual({ kind: 'conflicts', paths: ['a.txt'] });
    expect(t.memfs.readFileSync(`${t.dir}/a.txt`, 'utf8')).toBe('1\n2\n3\n4\n5\n6\n<<<<<<< Updated upstream\nZ\n=======\nA\n>>>>>>> Stashed changes\n');
    expect(await status(t)).toEqual(['UU a.txt', 'M. b.txt', 'A. n.txt']);
  });

  it("refuses an index part that no longer applies, changing nothing", async () => {
    const { t, wt } = await repo();
    const s = (await pushStash(wt, ident, 's', { untracked: 'none', paths: null }))!;
    await t.write('a.txt', '1\n2\n3\n4\n5\nX\n');
    await t.commit('Move line 6');
    expect(await applyStash(wt, s.oid, true)).toEqual({ kind: 'indexRefused' });
    expect(await status(t)).toEqual([]);
  });

  it("refuses over a local change it would overwrite (its untracked files stay), and restores partially around an untracked file in the way", async () => {
    const { t, wt } = await repo();
    const s = (await pushStash(wt, ident, 's', { untracked: 'untracked', paths: null }))!;
    await t.write('b.txt', 'mine\n');
    const r = await applyStash(wt, s.oid, true);
    expect(r).toMatchObject({ kind: 'refused', error: { kind: 'DirtyWorktree', message: 'Your local changes to the following files would be overwritten by merge:' } });
    expect(await status(t)).toEqual(['.M b.txt', '?? u.txt']);
    await t.write('b.txt', 'b\n');
    await t.write('u.txt', 'other\n');
    expect(await applyStash(wt, s.oid, true)).toMatchObject({ kind: 'partial', error: { kind: 'Other', message: 'u.txt already exists, no checkout' } });
    expect([await status(t), t.memfs.readFileSync(`${t.dir}/u.txt`, 'utf8')]).toEqual([['M. a.txt', '.M b.txt', 'A. n.txt', '?? u.txt'], 'other\n']);
  });
});

describe('the list', () => {
  it('drops by oid keeping the chain, and stores a stash back at the top', async () => {
    const { t, wt, local } = await repo();
    const one = (await pushStash(wt, ident, 'one', { untracked: 'untracked', paths: null }))!;
    await local();
    const two = (await pushStash(wt, ident, 'two', { untracked: 'untracked', paths: null }))!;
    dropStash(wt, one.oid);
    expect([stashList(wt), t.memfs.readFileSync(`${t.repo.gitdir}/logs/refs/stash`, 'utf8')]).toEqual([[{ oid: two.oid, subject: 'On main: two' }], `${'0'.repeat(40)} ${two.oid} ${ident}\tOn main: two\n`]);
    storeStash(wt, ident, one.oid, 'On main: one');
    expect(stashList(wt).map((s) => s.oid)).toEqual([one.oid, two.oid]);
    dropStash(wt, one.oid);
    dropStash(wt, two.oid);
    expect([stashList(wt), t.memfs.existsSync(`${t.repo.gitdir}/refs/stash`)]).toEqual([[], false]);
    expect(() => subjectOf(wt, two.oid)).toThrow();
    expect([userMessage('On main: Fix x'), userMessage('WIP on main: 1a2b3c4 x'), userMessage('plain')]).toEqual(['Fix x', '1a2b3c4 x', 'plain']);
  });
});

// The ids below are git 2.53's for the same repositories (HEAD committed alike), under the parity clock.
describe('pushStash as git 2.53', () => {
  /** HEAD "Base": a.txt (and `files`). */
  async function small(files: Record<string, string> = {}) {
    const t = await makeTestRepo();
    await t.write('a.txt', 'a\n');
    for (const [p, text] of Object.entries(files)) await t.write(p, text);
    await t.commit('Base');
    return { t, wt: mainWt(t.repo) };
  }

  it("writes git's commits, and with -u an untracked files' commit even when there are none", async () => {
    const { wt } = await repo();
    expect((await pushStash(wt, ident, 'Fix x', { untracked: 'untracked', paths: null }))!.oid).toBe('ec40b8795dfbe4adaae451464388acd87726f3d0');
    const { t, wt: wt2 } = await small();
    await t.write('a.txt', 'a2\n');
    const s = (await pushStash(wt2, ident, 'tracked only', { untracked: 'untracked', paths: null }))!;
    expect([s.oid, (await readCommit(t.repo, (await readCommit(t.repo, s.oid)).parents[2])).tree]).toEqual(['61bf2498af5114a179103ab9f9722fa50d35d742', EMPTY_TREE]);
  });

  it('keeps a staged addition whose file is gone, and takes back a staged deletion whose file is there', async () => {
    const one = await small();
    await one.t.write('a.txt', 'a2\n');
    await one.t.stage('a.txt');
    await one.t.write('a.txt', 'a\n');
    await one.t.write('n.txt', 'n\n');
    await one.t.stage('n.txt');
    one.t.memfs.unlinkSync(`${one.t.dir}/n.txt`);
    expect((await pushStash(one.wt, ident, 'back', { untracked: 'none', paths: null }))!.oid).toBe('06ef1c7651820b98db4963b6325d3ccf8fd84243');
    const two = await small({ 'b.txt': 'b\n' });
    await saveIndex(two.wt, withEntry(await loadIndex(two.wt), 'b.txt', null));
    expect((await pushStash(two.wt, ident, 'rmc', { untracked: 'untracked', paths: null }))!.oid).toBe('1aeb0691ea363c270785da617e8d72ef032e7d29');
    expect([await status(two.t), two.t.memfs.readFileSync(`${two.t.dir}/b.txt`, 'utf8')]).toEqual([[], 'b\n']);
  });

  it('refuses an intent-to-add file that is there, and stashes one whose file is gone', async () => {
    const { t, wt } = await small();
    await t.write('i.txt', 'i\n');
    await saveIndex(wt, withEntry(await loadIndex(wt), 'i.txt', { path: 'i.txt', mode: 0o100644, oid: EMPTY_BLOB, stage: 0, intentToAdd: true }));
    await expect(pushStash(wt, ident, 'ita', { untracked: 'untracked', paths: null })).rejects.toMatchObject({ kind: 'DirtyWorktree', message: "Entry 'i.txt' not uptodate. Cannot merge." });
    // Out of the paths, with no change in them: nothing to stash comes first.
    expect(await pushStash(wt, ident, 'ita', { untracked: 'untracked', paths: ['a.txt'] })).toBeNull();
    t.memfs.unlinkSync(`${t.dir}/i.txt`);
    expect((await pushStash(wt, ident, 'ita gone', { untracked: 'untracked', paths: null }))!.oid).toBe('f63001553de1badf375b4e731e1934473f793f16');
    expect(await status(t)).toEqual([]);
  });

  it('stashes ignored files with all, and empties folders as git clean -d does', async () => {
    const { t, wt } = await small({ '.gitignore': '*.log\nbuild/\n' });
    await t.write('x.log', 'log\n');
    await t.write('build/out.o', 'o\n');
    await t.write('u.txt', 'u\n');
    t.memfs.mkdirpSync(`${t.dir}/empty/deeper`);
    t.memfs.mkdirpSync(`${t.dir}/build/empty`);
    expect((await pushStash(wt, ident, 'u only', { untracked: 'untracked', paths: null }))!.oid).toBe('8652aaa613a90bd497307c0c2f52096bc574292a');
    expect([t.memfs.existsSync(`${t.dir}/empty`), t.memfs.existsSync(`${t.dir}/build/empty`), t.memfs.existsSync(`${t.dir}/build/out.o`)]).toEqual([false, false, true]);
    expect((await pushStash(wt, ident, 'everything', { untracked: 'all', paths: null }))!.oid).toBe('8878eacf88de78a909f26962596c6367982e08cf');
    expect(t.memfs.existsSync(`${t.dir}/build`)).toBe(false);
  });

  it("refuses an unborn HEAD and a conflicted index in git's words", async () => {
    const t = await makeTestRepo();
    await t.write('a.txt', 'a\n');
    await expect(pushStash(mainWt(t.repo), ident, 'x', { untracked: 'untracked', paths: null })).rejects.toMatchObject({ kind: 'Other', message: 'You do not have the initial commit yet' });
    const { wt } = await small();
    const a = (await loadIndex(wt))[0];
    await saveIndex(wt, [{ ...a, stage: 1 }, { ...a, stage: 2 }]);
    await expect(pushStash(wt, ident, 'x', { untracked: 'untracked', paths: null })).rejects.toMatchObject({ kind: 'Other', message: 'could not write index' });
  });

  it('folds whitespace in list lines as git does, and a store of the top stash logs nothing', async () => {
    expect(reflogMessage(' a\t\tb \v c\r\n')).toBe('a b \v c');
    const { t, wt } = await small();
    await t.write('a.txt', 'a2\n');
    const s = (await pushStash(wt, ident, 'one', { untracked: 'none', paths: null }))!;
    storeStash(wt, ident, s.oid, 'On main: again');
    expect(stashList(wt)).toEqual([{ oid: s.oid, subject: 'On main: one' }]);
  });
});

describe('applyStash as git 2.53', () => {
  it('with an index part, refuses a staged change elsewhere (the index reset to HEAD); without one, applies over it', async () => {
    const { t, wt } = await repo();
    const s = (await pushStash(wt, ident, 's', { untracked: 'none', paths: null }))!;
    await t.write('c.txt', 'c2\n');
    await t.stage('c.txt');
    expect(await applyStash(wt, s.oid, true)).toMatchObject({ kind: 'refused', error: { kind: 'DirtyWorktree', stderr: 'error: Your local changes to the following files would be overwritten by merge:\n  c.txt\nIndex was not unstashed.\n' } });
    expect(await status(t)).toEqual(['.M c.txt', '?? u.txt']);
    const { t: t2, wt: wt2 } = await repo();
    await t2.write('a.txt', '1\n2\n3\n4\n5\n6\n');
    await t2.stage('a.txt');
    await t2.remove('n.txt');
    await t2.stage('n.txt');
    const s2 = (await pushStash(wt2, ident, 's', { untracked: 'untracked', paths: null }))!;
    await t2.write('c.txt', 'c2\n');
    await t2.stage('c.txt');
    expect(await applyStash(wt2, s2.oid, true)).toEqual({ kind: 'applied' });
    expect(await status(t2)).toEqual(['.M b.txt', 'M. c.txt', '?? u.txt']);
  });

  it('refuses an index part that no longer applies to a staged change, and an intent-to-add entry, changing nothing', async () => {
    const { t, wt } = await repo();
    const s = (await pushStash(wt, ident, 's', { untracked: 'untracked', paths: null }))!;
    await t.write('a.txt', '1\n2\n3\n4\n5\n6\nQ\n');
    await t.stage('a.txt');
    expect(await applyStash(wt, s.oid, true)).toEqual({ kind: 'indexRefused' });
    expect(await status(t)).toEqual(['M. a.txt']);
    await t.write('a.txt', '1\n2\n3\n4\n5\n6\n');
    await t.stage('a.txt');
    await t.write('i.txt', 'i\n');
    await saveIndex(wt, withEntry(await loadIndex(wt), 'i.txt', { path: 'i.txt', mode: 0o100644, oid: EMPTY_BLOB, stage: 0, intentToAdd: true }));
    expect(await applyStash(wt, s.oid, false)).toMatchObject({ kind: 'refused', error: { stderr: 'error: Your local changes to the following files would be overwritten by merge:\n  i.txt\n' } });
    expect(await status(t)).toEqual(['.A i.txt', '?? u.txt']);
  });
});

describe('applyStash: an untracked file in the way', () => {
  it('is noted on a refusal and on conflicts too (the autostash restore reads it first)', async () => {
    const inTheWay = { kind: 'Other', message: 'u.txt already exists, no checkout', commandId: null, stderr: 'u.txt already exists, no checkout\nerror: could not restore untracked files from stash\n' };
    const one = await repo();
    const s1 = (await pushStash(one.wt, ident, 's', { untracked: 'untracked', paths: null }))!;
    await one.t.write('b.txt', 'mine\n');
    await one.t.write('u.txt', 'other\n');
    expect(await applyStash(one.wt, s1.oid, true)).toMatchObject({ kind: 'refused', error: { kind: 'DirtyWorktree' }, untracked: inTheWay });
    const two = await repo();
    const s2 = (await pushStash(two.wt, ident, 's', { untracked: 'untracked', paths: null }))!;
    await two.t.write('a.txt', '1\n2\n3\n4\n5\n6\nZ\n');
    await two.t.commit('Change a');
    await two.t.write('u.txt', 'other\n');
    expect(await applyStash(two.wt, s2.oid, false)).toEqual({ kind: 'conflicts', paths: ['a.txt'], untracked: inTheWay });
    expect(await status(two.t)).toEqual(['UU a.txt', 'M. b.txt', 'A. n.txt', '?? u.txt']);
  });
});

describe('patchEntry', () => {
  const ten = '1\n2\n3\n4\n5\n6\n7\n8\n9\n10\n';
  /** `old` → `next` onto `onto` (as git apply --cached), the result's lines joined by commas; null: refused. */
  async function patch(old: string, next: string, onto: string): Promise<string | null> {
    const t = await makeTestRepo();
    const wt = mainWt(t.repo);
    const blob = async (text: string) => ({ mode: 0o100644, oid: await writeBlobBytes(t.repo, new TextEncoder().encode(text)) });
    const r = await patchEntry(wt, await blob(old), await blob(next), await blob(onto));
    return r?.entry ? new TextDecoder().decode(await readBlobBytes(t.repo, r.entry.oid)).replaceAll('\n', ',') : null;
  }

  it('places hunks as git apply does: the nearest offset (forward first), any order, anchored at a file\'s start and end', async () => {
    expect(await patch(ten, ten.replace('7\n', 'X\n'), `0\n${ten}`)).toBe('0,1,2,3,4,5,6,X,8,9,10,');
    expect(await patch(ten, ten.replace('2\n', 'X\n'), `0\n${ten}`)).toBeNull();
    expect(await patch(ten, ten.replace('10\n', 'X\n'), `${ten}11\n`)).toBeNull();
    expect(await patch(ten, ten.replace('10\n', 'X\n'), `0\n${ten}`)).toBe('0,1,2,3,4,5,6,7,8,9,X,');
    expect(await patch(ten, ten.replace('9\n', 'X\n'), `${ten}11\n`)).toBe('1,2,3,4,5,6,7,8,X,10,11,');
    const twenty = Array.from({ length: 20 }, (_, i) => `${i + 1}\n`).join('');
    const swapped = '13\n14\n15\n16\n17\n18\n19\n2\n3\n4\n5\n6\n7\n8\nz\n';
    expect(await patch(twenty, twenty.replace('\n5\n', '\nX\n').replace('16\n', 'Y\n'), swapped)).toBe('13,14,15,Y,17,18,19,2,3,4,X,6,7,8,z,');
    // A hunk may not match over the lines an earlier one wrote.
    const n = (...xs: (number | string)[]) => xs.map((x) => `${x}\n`).join('');
    const range = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, k) => a + k);
    expect(await patch(twenty, n(1, ...range(13, 19), ...range(9, 15), 'Y', ...range(17, 20)), n(...range(1, 12), 'q', 20))).toBeNull();
    expect(await patch('y\ny\nx\nx\nx\nc\nx\nx\nx\ny\ny\n', 'y\ny\nx\nx\nx\nC\nx\nx\nx\ny\ny\n', 'x\nx\nx\nc\nx\nx\nx\nc\nx\nx\nx\n')).toBe('x,x,x,c,x,x,x,C,x,x,x,');
  });
});
