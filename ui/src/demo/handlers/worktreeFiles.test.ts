import { describe, expect, it } from 'vitest';
import { blobId } from '../engine/read/bytes';
import { fakeCtx, makeTestRepo, setIndex } from '../engine/read/testkit';
import { loadIndex } from '../engine/write/index';
import { EMPTY_BLOB } from '../engine/write/objects';
import { mainWt } from '../engine/write/seam';
import { statusEntries } from '../engine/write/status';
import { worktreeFileHandlers as h } from './worktreeFiles';

async function repo() {
  const t = await makeTestRepo();
  await t.write('a.txt', 'one\r\ntwo\r\n');
  await t.write('b.txt', 'b\n');
  await t.write('x.bin', Uint8Array.from([0, 1, 2]));
  const first = await t.commit('First');
  await t.write('a.txt', 'one\r\ntwo\r\nthree\r\n');
  await t.remove('b.txt');
  await t.commit('Second');
  return { t, first, ctx: fakeCtx(t.repo) };
}

const read = (t: Awaited<ReturnType<typeof repo>>['t'], p: string) => t.memfs.readFileSync(`${t.dir}/${p}`, 'utf8') as string;
const base = async (t: Awaited<ReturnType<typeof repo>>['t'], p: string) => blobId(t.memfs.readFileSync(`${t.dir}/${p}`) as Uint8Array);

describe('saving', () => {
  it('saves in the file line endings, coalesces saves of one file, and keeps a suggestion apart', async () => {
    const { t, ctx } = await repo();
    const r = await h.writeWorktreeFile({ repo: 1, worktree: t.dir, path: 'a.txt', text: 'one\ntwo\nthree\nfour\n', base: await base(t, 'a.txt') }, ctx);
    expect([read(t, 'a.txt'), r.outcome.hash, r.journal.undo?.label]).toEqual(['one\r\ntwo\r\nthree\r\nfour\r\n', await base(t, 'a.txt'), 'save a.txt']);
    await h.writeWorktreeFile({ repo: 1, worktree: t.dir, path: 'a.txt', text: 'five\n', base: r.outcome.hash }, ctx);
    expect(ctx.writes.journal(t.dir).undo.map((e) => e.label)).toEqual(['save a.txt']);
    await h.applySuggestion({ repo: 1, worktree: t.dir, path: 'a.txt', text: 'six\n', base: await base(t, 'a.txt'), expect: { head: null, refs: {} } }, ctx);
    expect(ctx.writes.journal(t.dir).undo.map((e) => e.label)).toEqual(['save a.txt', 'apply the suggestion to a.txt']);
  });

  it('refuses a stale base, a binary file and a conflicted one, leaving no entry', async () => {
    const { t, ctx } = await repo();
    await expect(h.writeWorktreeFile({ repo: 1, worktree: t.dir, path: 'a.txt', text: 'x', base: 'f'.repeat(40) }, ctx)).rejects.toMatchObject({ kind: 'Stale', message: 'a.txt changed on disk' });
    await expect(h.writeWorktreeFile({ repo: 1, worktree: t.dir, path: 'x.bin', text: 'x', base: await base(t, 'x.bin') }, ctx)).rejects.toMatchObject({ kind: 'InvalidInput', message: 'x.bin is binary: edit it in your editor' });
    const [a] = await loadIndex(mainWt(t.repo));
    await setIndex(t, [{ ...a, stage: 2 }, { ...a, stage: 3 }]);
    await expect(h.writeWorktreeFile({ repo: 1, worktree: t.dir, path: 'a.txt', text: 'x', base: await base(t, 'a.txt') }, ctx)).rejects.toMatchObject({ kind: 'InProgress', message: 'a.txt has merge conflicts: resolve it in the merge tool' });
    expect(ctx.writes.journal(t.dir).undo).toEqual([]);
  });
});

describe('createWorktreeFile', () => {
  it('makes an empty file and its folders, and refuses what is in the way', async () => {
    const { t, ctx } = await repo();
    const r = await h.createWorktreeFile({ repo: 1, worktree: t.dir, path: 'd/e/new.txt' }, ctx);
    expect([read(t, 'd/e/new.txt'), r.outcome.hash, r.journal.undo?.label, ctx.writes.journal(t.dir).undoTop()?.before?.paths]).toEqual(['', EMPTY_BLOB, 'create d/e/new.txt', ['d/e/new.txt', 'd/e', 'd']]);
    await expect(h.createWorktreeFile({ repo: 1, worktree: t.dir, path: 'a.txt' }, ctx)).rejects.toMatchObject({ kind: 'InvalidInput', message: 'a.txt already exists' });
    await expect(h.createWorktreeFile({ repo: 1, worktree: t.dir, path: 'a.txt/x' }, ctx)).rejects.toMatchObject({ message: "a.txt/x can't be made: a.txt is a file" });
  });
});

describe('restoreFile', () => {
  it('restores an older version unstaged, asking first over local changes', async () => {
    const { t, first, ctx } = await repo();
    const r = await h.restoreFile({ repo: 1, worktree: t.dir, sha: first, path: 'a.txt' }, ctx);
    expect([read(t, 'a.txt'), r.journal.undo?.label, (await statusEntries(t.repo, t.dir)).map((e) => [e.path, e.index, e.worktree])]).toEqual(['one\r\ntwo\r\n', `restore a.txt from ${first.slice(0, 7)}`, [['a.txt', '.', 'M']]]);
    await t.write('a.txt', 'mine\n');
    await expect(h.restoreFile({ repo: 1, worktree: t.dir, sha: first, path: 'a.txt' }, ctx)).rejects.toMatchObject({ kind: 'DirtyWorktree', message: 'Replace your changes to a.txt?', detail: { kind: 'restoreOverChanges', path: 'a.txt' } });
    await h.restoreFile({ repo: 1, worktree: t.dir, sha: first, path: 'a.txt', confirm: true }, ctx);
    expect(read(t, 'a.txt')).toBe('one\r\ntwo\r\n');
  });

  it('deletes a file the commit lacks, and refuses nothing to delete and a bad sha', async () => {
    const { t, first, ctx } = await repo();
    const second = await t.rev('main');
    await t.write('b.txt', 'back\n');
    const r = await h.restoreFile({ repo: 1, worktree: t.dir, sha: second, path: 'b.txt', confirm: true }, ctx);
    expect([t.memfs.existsSync(`${t.dir}/b.txt`), r.journal.undo?.label]).toEqual([false, `delete b.txt (as in ${second.slice(0, 7)})`]);
    await expect(h.restoreFile({ repo: 1, worktree: t.dir, sha: second, path: 'b.txt' }, ctx)).rejects.toMatchObject({ kind: 'InvalidInput', message: "b.txt isn't in the working tree: nothing to delete" });
    await expect(h.restoreFile({ repo: 1, worktree: t.dir, sha: first.slice(0, 12), path: 'a.txt' }, ctx)).rejects.toMatchObject({ kind: 'InvalidInput', message: `not an object id: ${first.slice(0, 12)}` });
  });
});

describe('restoreFile as git restore --source does', () => {
  it('brings back the executable bit, and replaces a file standing where a folder was', async () => {
    const t = await makeTestRepo();
    await t.write('d/x', 'x\n');
    await t.write('run.sh', '#!/bin/sh\n', { exec: true });
    const first = await t.commit('One');
    await t.remove('d/x');
    t.memfs.rmdirSync(`${t.dir}/d`);
    await t.write('d', 'now a file\n');
    await t.write('run.sh', '#!/bin/sh\n');
    await t.commit('Two');
    const ctx = fakeCtx(t.repo);
    await h.restoreFile({ repo: 1, worktree: t.dir, sha: first, path: 'run.sh', confirm: true }, ctx);
    expect((t.memfs.statSync(`${t.dir}/run.sh`).mode & 0o111) !== 0).toBe(true);
    await h.restoreFile({ repo: 1, worktree: t.dir, sha: first, path: 'd/x', confirm: true }, ctx);
    expect([read(t, 'd/x'), (await statusEntries(t.repo, t.dir)).map((e) => [e.path, e.index, e.worktree])]).toEqual(['x\n', [['d', '.', 'D'], ['run.sh', '.', 'M'], ['d/x', '?', '?']]]);
  });
});

describe('through a symlinked folder', () => {
  it('saves into the real folder and keeps the link; a restore beyond it is refused after the sha is looked up', async () => {
    const t = await makeTestRepo();
    await t.write('docs/a.txt', 'one\n');
    const first = await t.commit('One');
    await t.link('d', 'docs');
    const ctx = fakeCtx(t.repo);
    await h.writeWorktreeFile({ repo: 1, worktree: t.dir, path: 'd/a.txt', text: 'two\n', base: await base(t, 'docs/a.txt') }, ctx);
    expect([t.memfs.lstatSync(`${t.dir}/d`).isSymbolicLink(), read(t, 'docs/a.txt')]).toEqual([true, 'two\n']);
    await expect(h.restoreFile({ repo: 1, worktree: t.dir, sha: first, path: 'd/a.txt', confirm: true }, ctx)).rejects.toMatchObject({ kind: 'NotFound', message: "pathspec 'd/a.txt' did not match any file(s) known to git" });
    await expect(h.restoreFile({ repo: 1, worktree: t.dir, sha: 'a'.repeat(40), path: 'd/a.txt' }, ctx)).rejects.toMatchObject({ kind: 'NotFound', message: 'aaaaaaa: no such commit' });
    expect(t.memfs.lstatSync(`${t.dir}/d`).isSymbolicLink()).toBe(true);
  });
});
