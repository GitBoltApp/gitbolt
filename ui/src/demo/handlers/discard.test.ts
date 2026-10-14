import { describe, expect, it } from 'vitest';
import { fakeCtx, makeTestRepo, setIndex, thirty } from '../engine/read/testkit';
import { MODE_FILE } from '../engine/read/trees';
import { baseOf } from '../engine/read/wipDiff';
import { readFileState } from '../engine/write/files';
import { loadIndex } from '../engine/write/index';
import { mainWt } from '../engine/write/seam';
import { discardHandlers } from './discard';

const text = (t: Awaited<ReturnType<typeof makeTestRepo>>, p: string) => {
  const f = readFileState(mainWt(t.repo), p);
  return f && new TextDecoder().decode(f.bytes);
};

async function repo() {
  const t = await makeTestRepo();
  await t.write('a.txt', 'a\n');
  await t.write('f.txt', thirty([]));
  await t.write('s.txt', 's\n');
  await t.commit('Base');
  await t.write('a.txt', 'a edited\n');
  await t.write('f.txt', thirty([3, 20]));
  await t.write('s.txt', 's staged\n');
  await t.stage('s.txt');
  await t.write('s.txt', 's staged, then edited\n');
  await t.write('new.txt', 'one\ntwo\n');
  return { t, ctx: fakeCtx(t.repo) };
}

describe('discard', () => {
  it('discards paths: edits written back from the index, untracked files deleted, journaled both ways', async () => {
    const { t, ctx } = await repo();
    const r = await discardHandlers.discard({ repo: 1, worktree: t.dir, scope: { kind: 'paths', paths: ['a.txt', 'new.txt', 's.txt'] } }, ctx);
    expect(r.journal.undo).toMatchObject({ label: 'discard 3 files', kind: 'discard' });
    expect([text(t, 'a.txt'), text(t, 'new.txt'), text(t, 's.txt')]).toEqual(['a\n', null, 's staged\n']);
    const e = ctx.writes.journal(t.dir).undoTop()!;
    expect([e.undo, e.before?.paths, e.before?.untracked]).toEqual(['restore', ['new.txt', 'a.txt', 's.txt'], ['new.txt']]);
    expect(e.after?.held.get('new.txt')?.file).toBeNull();
  });

  it('discards a hunk and the lines of an untracked file', async () => {
    const { t, ctx } = await repo();
    await discardHandlers.discard({ repo: 1, worktree: t.dir, scope: { kind: 'patch', path: 'f.txt', selection: { kind: 'hunks', hunks: [1] }, base: await baseOf(t.repo, t.dir, 'f.txt') } }, ctx);
    expect(text(t, 'f.txt')).toBe(thirty([3]));
    const r = await discardHandlers.discard({ repo: 1, worktree: t.dir, scope: { kind: 'patch', path: 'new.txt', selection: { kind: 'lines', old: [], new: [{ start: 1, end: 1 }] }, base: await baseOf(t.repo, t.dir, 'new.txt') } }, ctx);
    expect([text(t, 'new.txt'), r.journal.undo?.label]).toEqual(['two\n', 'discard 1 line in new.txt']);
  });

  it('discards unstaged changes (the staged half stays) and all changes', async () => {
    const { t, ctx } = await repo();
    await discardHandlers.discard({ repo: 1, worktree: t.dir, scope: { kind: 'unstaged' } }, ctx);
    expect([text(t, 's.txt'), text(t, 'new.txt')]).toEqual(['s staged\n', null]);
    const r = await discardHandlers.discard({ repo: 1, worktree: t.dir, scope: { kind: 'all' } }, ctx);
    expect([r.journal.undo?.label, text(t, 's.txt'), r.wip?.staged.files, r.wip?.unstaged.files]).toEqual(['discard all changes', 's\n', [], []]);
  });

  it('a folder where a deleted file comes back is counted, held and deleted with it', async () => {
    const { t, ctx } = await repo();
    await t.remove('a.txt');
    await t.write('a.txt/inner.txt', 'in the way\n');
    const r = await discardHandlers.discard({ repo: 1, worktree: t.dir, scope: { kind: 'paths', paths: ['a.txt'] } }, ctx);
    expect([r.journal.undo?.label, text(t, 'a.txt')]).toEqual(['discard 2 files', 'a\n']);
    expect(ctx.writes.journal(t.dir).undoTop()!.before?.untracked).toEqual(['a.txt/inner.txt']);
  });

  it('discards all of an unborn repository: its files leave the index and the disk', async () => {
    const t = await makeTestRepo();
    const ctx = fakeCtx(t.repo);
    await t.write('a.txt', 'a\n');
    await t.stage('a.txt');
    await t.write('b.txt', 'b\n');
    await discardHandlers.discard({ repo: 1, worktree: t.dir, scope: { kind: 'all' } }, ctx);
    expect([text(t, 'a.txt'), text(t, 'b.txt'), (await loadIndex(mainWt(t.repo))).length]).toEqual([null, null, 0]);
  });

  it('refuses what it must not touch, and what changed since it was shown or confirmed', async () => {
    const { t, ctx } = await repo();
    await expect(discardHandlers.discard({ repo: 1, worktree: t.dir, scope: { kind: 'paths', paths: ['nope.txt'] } }, ctx)).rejects.toMatchObject({ kind: 'Stale', message: 'nope.txt changed since it was shown' });
    await expect(discardHandlers.discard({ repo: 1, worktree: t.dir, scope: { kind: 'all', confirmed: ['a.txt'] } }, ctx)).rejects.toMatchObject({ kind: 'Stale', message: 'f.txt changed since you confirmed: look again, then discard' });
    // A deleted file's lines: the core reads the file's metadata after the diff, and its absence is Stale.
    await t.remove('f.txt');
    await expect(discardHandlers.discard({ repo: 1, worktree: t.dir, scope: { kind: 'patch', path: 'f.txt', selection: { kind: 'hunks', hunks: [0] }, base: await baseOf(t.repo, t.dir, 'f.txt') } }, ctx)).rejects.toMatchObject({ kind: 'Stale', message: 'f.txt changed since it was shown' });
    await t.write('f.txt', thirty([]), { exec: true });
    await expect(discardHandlers.discard({ repo: 1, worktree: t.dir, scope: { kind: 'patch', path: 'f.txt', selection: { kind: 'hunks', hunks: [0] }, base: await baseOf(t.repo, t.dir, 'f.txt') } }, ctx)).rejects.toMatchObject({ kind: 'InvalidInput', message: "Only the file's mode changed: discard the whole file" });
    const blob = (await loadIndex(mainWt(t.repo))).find((e) => e.path === 'a.txt')!.oid;
    await setIndex(t, [{ path: 'a.txt', mode: MODE_FILE, oid: blob, stage: 2 }, { path: 'a.txt', mode: MODE_FILE, oid: blob, stage: 3 }]);
    await expect(discardHandlers.discard({ repo: 1, worktree: t.dir, scope: { kind: 'all' } }, ctx)).rejects.toMatchObject({ kind: 'InProgress', message: 'a.txt has merge conflicts: resolve conflicts first' });
    expect(ctx.writes.journal(t.dir).undo).toEqual([]);
  });

  it('refuses a repository where a deleted file comes back, and a symbolic link where a folder was', async () => {
    const { t, ctx } = await repo();
    await t.remove('a.txt');
    await t.write('a.txt/.git/HEAD', 'ref: refs/heads/main\n');
    await expect(discardHandlers.discard({ repo: 1, worktree: t.dir, scope: { kind: 'paths', paths: ['a.txt'] } }, ctx)).rejects.toMatchObject({ kind: 'InvalidInput', message: 'a.txt is a repository in the way: move it first' });
    const u = await makeTestRepo('links');
    await u.write('dir/x.txt', 'x\n');
    await u.commit('Base');
    u.memfs.unlinkSync(`${u.dir}/dir/x.txt`);
    u.memfs.rmdirSync(`${u.dir}/dir`);
    await u.link('dir', 'elsewhere');
    await expect(discardHandlers.discard({ repo: 1, worktree: u.dir, scope: { kind: 'paths', paths: ['dir/x.txt'] } }, fakeCtx(u.repo))).rejects.toMatchObject({ kind: 'InvalidInput', message: 'dir is a symbolic link where a folder of dir/x.txt was: move it first' });
  });
});
