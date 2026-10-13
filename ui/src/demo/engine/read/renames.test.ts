import { describe, expect, it } from 'vitest';
import { MODE_FILE, MODE_LINK } from './trees';
import { MAX_SCORE, MIN_SCORE, pairRenames, renamePairs, similarity, similarityTo, type RenameFile } from './renames';
import { makeTestRepo } from './testkit';
import { diffTrees } from './trees';

const enc = (s: string) => new TextEncoder().encode(s);
const file = (path: string, text: string, oid = `${path}-oid`, mode = MODE_FILE): RenameFile => ({ path, oid, mode, load: async () => enc(text) });
const lines = (n: number, tag = '') => Array.from({ length: n }, (_, i) => `step ${i}${tag}\n`).join('');

describe('renames', () => {
  it('scores shared bytes over the larger file', () => {
    expect(similarity(enc(lines(10)), enc(lines(10)))).toBe(MAX_SCORE);
    const one = lines(10).replace('step 3\n', 'step three\n');
    const s = similarity(enc(lines(10)), enc(one));
    expect(s).toBeGreaterThan(MIN_SCORE);
    expect(s).toBeLessThan(MAX_SCORE);
    expect(similarity(enc(lines(10)), enc(lines(10, '!')))).toBe(0);
    expect(similarity(enc('a\n'), enc(lines(10)))).toBe(0);
    expect(similarity(enc('a\r\nb\r\n'), enc('a\nb\n'))).toBeGreaterThanOrEqual(Math.floor((4 * MAX_SCORE) / 6));
  });

  it('scores many sources against one profiled target as it scores each pair', () => {
    const dst = enc(lines(10));
    const sources = [lines(10), lines(9), lines(10, '!'), 'a\n', lines(12)].map(enc);
    const scoreOf = similarityTo(dst);
    expect(sources.map((s) => scoreOf(s))).toEqual(sources.map((s) => similarity(s, dst)));
  });

  it('tells every byte apart in chunks', () => {
    for (let b = 0x80; b < 0xa0; b++) {
      for (let c = 0; c < 256; c++) expect(similarity(Uint8Array.of(b, 10), Uint8Array.of(c, 10))).toBe(b === c ? MAX_SCORE : 0);
    }
  });

  it('pairs exact renames first, preferring the same file name', async () => {
    const pairs = await pairRenames([file('a/guide.txt', 'x\n', 'same'), file('b/manual.txt', 'x\n', 'same')], [file('c/manual.txt', 'x\n', 'same')]);
    expect(pairs.map((p) => [p.from.path, p.to.path, p.score])).toEqual([['b/manual.txt', 'c/manual.txt', MAX_SCORE]]);
  });

  it('pairs empty files only with each other, as git 2.53 does', async () => {
    const empty = 'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391';
    const pairs = await pairRenames([file('a/x', '', empty), file('b/empty.txt', '', empty)], [file('c/empty.txt', '', empty), file('full', 'hello\n')]);
    expect(pairs.map((p) => [p.from.path, p.to.path, p.score])).toEqual([['b/empty.txt', 'c/empty.txt', MAX_SCORE]]);
  });

  it('pairs an edited file at 50% or more, and leaves a dissimilar one', async () => {
    const before = `Guide\n\n${lines(8)}`;
    const after = before.replace('step 2\n', 'step 2, revised\n');
    const pairs = await pairRenames([file('docs/guide.txt', before), file('old.txt', 'to be deleted\n')], [file('docs/manual.txt', after), file('new.txt', 'nothing alike at all\n')]);
    expect(pairs.map((p) => [p.from.path, p.to.path])).toEqual([['docs/guide.txt', 'docs/manual.txt']]);
  });

  it('moves a file whose name stays when it is similar enough', async () => {
    const text = lines(20);
    const pairs = await pairRenames([file('story.txt', text)], [file('src/story.txt', text.replace('step 5\n', 'step five\n'))]);
    expect(pairs).toHaveLength(1);
    expect(pairs[0].score).toBeGreaterThanOrEqual(45_000);
  });

  it('pairs a unique file name at 75% before a better-scoring other name', async () => {
    const text = lines(40);
    const edit = (every: number) => text.split('\n').map((l, i) => (l && i % every === 3 ? `${l} edited` : l)).join('\n');
    const sameName = file('one/notes.txt', edit(8));
    const better = file('other.txt', edit(40));
    const dst = file('two/notes.txt', text);
    const pairs = await pairRenames([sameName, better], [dst]);
    expect(pairs.map((p) => [p.from.path, p.to.path])).toEqual([['one/notes.txt', 'two/notes.txt']]);
    expect(pairs[0].score).toBeGreaterThanOrEqual(45_000);
    expect(pairs[0].score).toBeLessThan(similarity(enc(edit(40)), enc(text)));
    // With the name twice among the sources, the best score wins instead.
    const twice = await pairRenames([sameName, file('b/notes.txt', `${edit(8)}x\n`), better], [dst]);
    expect(twice.map((p) => p.from.path)).toEqual(['other.txt']);
  });

  it('rules out a file more than twice the size of the other', () => {
    expect(similarity(enc('abcd\nabcd\n'), enc('abcd\nabcd\nwxyz\nwxyz\n'))).toBe(MIN_SCORE);
    expect(similarity(enc('abcd\nabcd\n'), enc('abcd\nabcd\nwxyz\nwxyz\nq'))).toBe(0);
  });

  it('keeps four candidates per destination as git does: a later source only replaces a weaker one', async () => {
    // d0 takes s5 first. d1's equals were s0 to s4: s4 couldn't displace them, and s5 took s0's
    // slot, so d1 gets s1 (git pairs it the same way).
    const base = Array.from({ length: 30 }, (_, i) => `step ${i}\n`);
    const up = (...at: number[]) => base.map((l, i) => (at.includes(i) ? l.toUpperCase() : l)).join('');
    const sources = [0, 1, 2, 3, 4].map((i) => file(`s${i}.txt`, up(10 + 2 * i, 11 + 2 * i)));
    const pairs = await pairRenames([...sources, file('s5.txt', up(29))], [file('d0.txt', `${up(29)}extra\n`), file('d1.txt', up())]);
    expect(pairs.map((p) => [p.from.path, p.to.path])).toEqual([['s5.txt', 'd0.txt'], ['s1.txt', 'd1.txt']]);
  });

  it('never pairs a symlink by similarity', async () => {
    expect(await pairRenames([file('l', 'target', 'x', MODE_LINK)], [file('m', 'target', 'y', MODE_LINK)])).toEqual([]);
  });

  it('finds the renames in a tree diff', async () => {
    const t = await makeTestRepo();
    await t.write('docs/guide.txt', lines(10));
    await t.write('old.txt', 'gone\n');
    const a = await t.commit('Base');
    await t.remove('docs/guide.txt');
    await t.write('docs/manual.txt', lines(10).replace('step 3\n', 'step three\n'));
    await t.remove('old.txt');
    await t.write('new.txt', 'unrelated\n');
    const b = await t.commit('Rename');
    const pairs = await renamePairs(t.repo, await diffTrees(t.repo, a, b));
    expect(pairs.map((p) => [p.from.path, p.to.path])).toEqual([['docs/guide.txt', 'docs/manual.txt']]);
  });
});
