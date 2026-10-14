import { describe, expect, it } from 'vitest';
import { fixedClock, PARITY_MS } from '../clock';
import { makeTestRepo } from '../read/testkit';
import { readCommit } from '../read/commitText';
import { readBlobBytes, entryAt } from '../read/trees';
import { writeCommitObject } from '../writeSeam';
import { labelsFor, replay, treeOf } from './replay';

async function forked() {
  const t = await makeTestRepo();
  await t.write('a.txt', 'one\ntwo\nthree\n');
  const base = await t.commit('Base');
  await t.branch('side');
  await t.write('a.txt', 'one\ntwo, main\nthree\n');
  const main = await t.commit('Main edits two');
  await t.checkout('side');
  await t.write('a.txt', 'one\ntwo, side\nthree\n');
  const side = await t.commit('Side edits two');
  await t.write('b.txt', 'bee\n');
  const clean = await t.commit('Add b');
  return { t, base, main, side, clean };
}

describe('replay', () => {
  it('picks a clean change onto another tree', async () => {
    const { t, main, clean } = await forked();
    const r = await replay(t.repo, clean, await treeOf(t.repo, main), 'pick');
    expect(r.conflicts).toEqual([]);
    const b = await entryAt(t.repo, r.tree!, 'b.txt');
    expect(new TextDecoder().decode(await readBlobBytes(t.repo, b!.oid))).toBe('bee\n');
    expect((await entryAt(t.repo, r.tree!, 'a.txt'))!.oid).toBe((await entryAt(t.repo, await treeOf(t.repo, main), 'a.txt'))!.oid);
  });

  it("conflicts with git's labels", async () => {
    const { t, main, side } = await forked();
    const r = await replay(t.repo, side, await treeOf(t.repo, main), 'pick');
    expect(r.tree).toBeNull();
    expect(r.conflicts).toEqual(['a.txt']);
    const text = new TextDecoder().decode(r.files.get('a.txt')!.bytes);
    expect(text).toBe(`one\n<<<<<<< HEAD\ntwo, main\n=======\ntwo, side\n>>>>>>> ${side.slice(0, 7)} (Side edits two)\nthree\n`);
  });

  it('reverts a change, labelled as its parent', async () => {
    const { t, main } = await forked();
    await t.checkout('main');
    await t.write('a.txt', 'one\ntwo, main again\nthree\n');
    const later = await t.commit('Main again');
    const r = await replay(t.repo, main, await treeOf(t.repo, later), 'revert');
    expect(r.conflicts).toEqual(['a.txt']);
    const text = new TextDecoder().decode(r.files.get('a.txt')!.bytes);
    expect(text).toBe(`one\n<<<<<<< HEAD\ntwo, main again\n=======\ntwo\n>>>>>>> parent of ${main.slice(0, 7)} (Main edits two)\nthree\n`);
    const c = await readCommit(t.repo, main);
    expect(labelsFor('revert', main, c)).toEqual({ ours: 'HEAD', theirs: `parent of ${main.slice(0, 7)} (Main edits two)`, base: `${main.slice(0, 7)} (Main edits two)` });
  });

  it("names a commit by its message's first non-blank line, as it is (git 2.53, not %s)", async () => {
    const { t, side } = await forked();
    const tree = await treeOf(t.repo, side);
    const oid = await writeCommitObject(t.repo, { tree, parents: [side], message: '\n  \nSide edits  \ntwo, wrapped\n\nbody\n' }, { clock: fixedClock(PARITY_MS) });
    const named = `${oid.slice(0, 7)} (Side edits  )`;
    const c = await readCommit(t.repo, oid);
    expect(labelsFor('pick', oid, c)).toEqual({ ours: 'HEAD', theirs: named, base: `parent of ${named}` });
    expect(labelsFor('revert', oid, c)).toEqual({ ours: 'HEAD', theirs: `parent of ${named}`, base: named });
    const empty = await writeCommitObject(t.repo, { tree, parents: [side], message: '' }, { clock: fixedClock(PARITY_MS) });
    expect(labelsFor('pick', empty, await readCommit(t.repo, empty)).theirs).toBe(`${empty.slice(0, 7)} ()`);
  });

  it('a root commit replays against the empty tree', async () => {
    const t = await makeTestRepo();
    await t.write('r.txt', 'root\n');
    const root = await t.commit('Root');
    await t.write('s.txt', 'second\n');
    const second = await t.commit('Second');
    const r = await replay(t.repo, root, await treeOf(t.repo, second), 'pick');
    expect(r.conflicts).toEqual([]);
    // Its revert removes what it added.
    const back = await replay(t.repo, root, await treeOf(t.repo, second), 'revert');
    expect(back.conflicts).toEqual([]);
    expect(await entryAt(t.repo, back.tree!, 'r.txt')).toBeNull();
    expect(await entryAt(t.repo, back.tree!, 's.txt')).not.toBeNull();
  });
});
