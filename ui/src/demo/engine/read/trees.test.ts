import { describe, expect, it } from 'vitest';
import { MODE_EXEC, MODE_FILE, diffTrees, entryAt, isTreeMode, listFiles, readBlobBytes, readRaw, readTree } from './trees';
import { parseCommit } from './commitText';
import { Lru } from './seam';
import { makeTestRepo } from './testkit';

describe('trees', () => {
  it('reads raw objects, and null for a missing one', async () => {
    const t = await makeTestRepo();
    await t.write('a.txt', 'one\n');
    const c = await t.commit('First');
    expect((await readRaw(t.repo, c))?.type).toBe('commit');
    expect(await readRaw(t.repo, '1'.repeat(40))).toBeNull();
    await expect(readBlobBytes(t.repo, '1'.repeat(40))).rejects.toMatchObject({ kind: 'NotFound' });
  });

  it('looks paths up through trees, and lists every file', async () => {
    const t = await makeTestRepo();
    await t.write('src/lib/a.rs', 'a\n');
    await t.write('src/run.sh', 'run\n', { exec: true });
    await t.write('README.md', 'hi\n');
    const c = await t.commit('First');
    const e = await entryAt(t.repo, c, 'src/run.sh');
    expect(e?.mode).toBe(MODE_EXEC);
    expect(new TextDecoder().decode(await readBlobBytes(t.repo, e!.oid))).toBe('run\n');
    expect(isTreeMode((await entryAt(t.repo, c, 'src'))!.mode)).toBe(true);
    expect(await entryAt(t.repo, c, 'src/nope')).toBeNull();
    expect(await entryAt(t.repo, c, 'README.md/x')).toBeNull();
    expect([...(await listFiles(t.repo, c)).keys()]).toEqual(['README.md', 'src/lib/a.rs', 'src/run.sh']);
    expect((await readTree(t.repo, c)).map((x) => x.name)).toEqual(['README.md', 'src']);
  });

  it('keeps one copy of a tree, whether read by its id or by a commit pointing at it', async () => {
    const t = await makeTestRepo();
    await t.write('a.txt', 'one\n');
    const c = await t.commit('First');
    const { tree } = parseCommit((await readRaw(t.repo, c))!.bytes);
    expect(await readTree(t.repo, c)).toBe(await readTree(t.repo, tree));
    expect(await listFiles(t.repo, tree)).toBe(await listFiles(t.repo, c));
  });

  it('caps an LRU: the least recently read goes first', () => {
    const lru = new Lru<number>(2);
    lru.set('a', 1);
    lru.set('b', 2);
    expect(lru.get('a')).toBe(1);
    lru.set('c', 3);
    expect([lru.get('a'), lru.get('b'), lru.get('c')]).toEqual([1, undefined, 3]);
  });

  it('diffs two trees: additions, deletions, edits and mode changes, skipping equal subtrees', async () => {
    const t = await makeTestRepo();
    await t.write('keep/x.txt', 'x\n');
    await t.write('gone.txt', 'bye\n');
    await t.write('edit.txt', 'one\n');
    await t.write('mode.sh', 'echo\n');
    const a = await t.commit('A');
    await t.remove('gone.txt');
    await t.write('edit.txt', 'two\n');
    await t.write('mode.sh', 'echo\n', { exec: true });
    await t.write('new/deep/n.txt', 'n\n');
    const b = await t.commit('B');
    const changes = await diffTrees(t.repo, a, b);
    expect(changes.map((c) => [c.path, c.old ? 'old' : '-', c.new ? 'new' : '-'])).toEqual([
      ['edit.txt', 'old', 'new'],
      ['gone.txt', 'old', '-'],
      ['mode.sh', 'old', 'new'],
      ['new/deep/n.txt', '-', 'new'],
    ]);
    expect(changes[2].old?.mode).toBe(MODE_FILE);
    expect(changes[2].new?.mode).toBe(MODE_EXEC);
    expect(await diffTrees(t.repo, null, a)).toHaveLength(4);
    expect(await diffTrees(t.repo, b, b)).toEqual([]);
  });

  it('turns a file replaced by a folder into a deletion and the folder\'s files', async () => {
    const t = await makeTestRepo();
    await t.write('docs', 'a file\n');
    const a = await t.commit('A');
    await t.remove('docs');
    await t.write('docs/guide.md', 'g\n');
    const b = await t.commit('B');
    expect((await diffTrees(t.repo, a, b)).map((c) => [c.path, !!c.old, !!c.new])).toEqual([['docs', true, false], ['docs/guide.md', false, true]]);
  });
});
