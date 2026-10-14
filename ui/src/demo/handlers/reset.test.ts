import { describe, expect, it } from 'vitest';
import type { ResetMode } from '../../api/gen/ResetMode';
import { fakeCtx, makeTestRepo, writeNested } from '../engine/read/testkit';
import { inProgressName } from '../engine/write/inProgress';
import { readHead, setHead } from '../engine/write/refs';
import { runWrite } from '../engine/write/run';
import { mainWt } from '../engine/write/seam';
import { statusEntries } from '../engine/write/status';
import { atRisk, resetHandlers, undoReset } from './reset';
import { NO_EXPECT } from './stage';

/** one (a.txt "1"), two (a.txt "2", b.txt). Local: a.txt "3" staged, b.txt "b2" unstaged, u.txt untracked. */
async function repo() {
  const t = await makeTestRepo();
  await t.write('a.txt', '1\n');
  const one = await t.commit('One');
  await t.write('a.txt', '2\n');
  await t.write('b.txt', 'b\n');
  const two = await t.commit('Two');
  await t.write('a.txt', '3\n');
  await t.stage('a.txt');
  await t.write('b.txt', 'b2\n');
  await t.write('u.txt', 'u\n');
  return { t, one, two, ctx: fakeCtx(t.repo), wt: mainWt(t.repo) };
}
const status = async (t: Awaited<ReturnType<typeof repo>>['t']) => (await statusEntries(t.repo, t.dir)).map((e) => `${e.index}${e.worktree} ${e.path}`);
const reset = (ctx: ReturnType<typeof fakeCtx>, dir: string, to: string, mode: ResetMode, discard?: boolean) => resetHandlers.reset({ repo: 1, worktree: dir, to, mode, expect: NO_EXPECT, ...(discard === undefined ? {} : { discard }) }, ctx);
const undoWrite = (ctx: ReturnType<typeof fakeCtx>, dir: string, id: number, undo: boolean) =>
  runWrite(ctx, 1, dir, NO_EXPECT, {
    kind: undo ? 'undo' : 'redo',
    label: () => 'undo test',
    undo: () => null,
    run: async (cx) => {
      const e = cx.journal.entry(id)!;
      const moves = e.refs.map((m) => (undo ? { name: m.name, old: m.new, new: m.old } : m));
      await undoReset(cx, e, moves, undo);
      return null;
    },
  });

describe('reset', () => {
  it('soft moves the branch only, and its undo moves it back', async () => {
    const { t, one, two, ctx, wt } = await repo();
    const before = await status(t);
    const r = await reset(ctx, t.dir, one, 'soft');
    const e = ctx.writes.journal(t.dir).undoTop()!;
    expect([readHead(wt).oid, r.journal.undo?.label, e.undo, e.before]).toEqual([one, `reset main to ${one.slice(0, 7)} (soft)`, 'resetSoft', null]);
    expect(await status(t)).toEqual(['M. a.txt', 'AM b.txt', '?? u.txt']);
    await undoWrite(ctx, t.dir, e.id, true);
    expect([readHead(wt).oid, await status(t)]).toEqual([two, before]);
  });

  it('mixed resets the index, keeping the files, and its undo brings the staged split back', async () => {
    const { t, one, ctx } = await repo();
    const before = await status(t);
    await reset(ctx, t.dir, one, 'mixed');
    expect([t.memfs.readFileSync(`${t.dir}/a.txt`, 'utf8'), await status(t)]).toEqual(['3\n', ['.M a.txt', '?? b.txt', '?? u.txt']]);
    const e = ctx.writes.journal(t.dir).undoTop()!;
    expect(e.before?.paths).toEqual(['a.txt', 'b.txt']);
    await undoWrite(ctx, t.dir, e.id, true);
    expect(await status(t)).toEqual(before);
    await undoWrite(ctx, t.dir, e.id, false);
    expect(await status(t)).toEqual(['.M a.txt', '?? b.txt', '?? u.txt']);
  });

  it('hard asks before discarding, counts an untracked file it overwrites, and its undo brings everything back', async () => {
    const { t, one, two, ctx, wt } = await repo();
    await t.checkout(one);
    setHead(wt, { branch: 'main' });
    const { casRefs } = await import('../engine/write/refs');
    casRefs(t.repo.demo!, [{ name: 'refs/heads/main', old: two, new: one }]);
    await t.write('b.txt', 'untracked where two has a file\n');
    await t.write('a.txt', 'mine\n');
    await expect(reset(ctx, t.dir, two, 'hard')).rejects.toMatchObject({ kind: 'DirtyWorktree', message: `Reset main to ${two.slice(0, 7)} and discard changes to 2 files? You can undo this.`, detail: { kind: 'resetDiscards', branch: 'main', to: two.slice(0, 7), files: 2 } });
    await reset(ctx, t.dir, two, 'hard', true);
    expect([t.memfs.readFileSync(`${t.dir}/a.txt`, 'utf8'), t.memfs.readFileSync(`${t.dir}/b.txt`, 'utf8')]).toEqual(['2\n', 'b\n']);
    const e = ctx.writes.journal(t.dir).undoTop()!;
    expect([e.before?.paths, e.before?.untracked]).toEqual([['b.txt', 'a.txt'], ['b.txt']]);
    await undoWrite(ctx, t.dir, e.id, true);
    expect([readHead(wt).oid, t.memfs.readFileSync(`${t.dir}/a.txt`, 'utf8'), t.memfs.readFileSync(`${t.dir}/b.txt`, 'utf8')]).toEqual([one, 'mine\n', 'untracked where two has a file\n']);
  });

  it("hard's undo checks its restore before anything moves: a folder in a snapshot file's place changes nothing", async () => {
    const t = await makeTestRepo();
    await t.write('a.txt', '1\n');
    await t.write('c.txt', 'c\n');
    const one = await t.commit('One');
    await t.write('a.txt', '2\n');
    await t.write('b.txt', 'b\n');
    await t.commit('Two');
    await t.write('c.txt', 'mine\n');
    const [ctx, wt] = [fakeCtx(t.repo), mainWt(t.repo)];
    const two = readHead(wt).oid;
    await reset(ctx, t.dir, one, 'hard', true);
    const e = ctx.writes.journal(t.dir).undoTop()!;
    t.memfs.unlinkSync(`${t.dir}/c.txt`);
    await t.write('c.txt/inside.txt', 'x\n');
    const before = await status(t);
    await expect(undoWrite(ctx, t.dir, e.id, true)).rejects.toMatchObject({ kind: 'DirtyWorktree', message: 'c.txt is a folder with files in it' });
    expect([readHead(wt).oid, t.memfs.readFileSync(`${t.dir}/a.txt`, 'utf8'), t.memfs.existsSync(`${t.dir}/b.txt`), await status(t)]).toEqual([one, '1\n', false, before]);
    t.memfs.unlinkSync(`${t.dir}/c.txt/inside.txt`);
    t.memfs.rmdirSync(`${t.dir}/c.txt`);
    await undoWrite(ctx, t.dir, e.id, true);
    expect([readHead(wt).oid, t.memfs.readFileSync(`${t.dir}/a.txt`, 'utf8'), t.memfs.readFileSync(`${t.dir}/c.txt`, 'utf8')]).toEqual([two, '2\n', 'mine\n']);
  });

  it('hard refuses a repository in a folder where the target has a file, and counts the files of any other folder', async () => {
    const t = await makeTestRepo();
    await t.write('d', 'd\n');
    await t.write('e', 'e\n');
    const one = await t.commit('One');
    await t.remove('d');
    await t.remove('e');
    await t.commit('Two');
    await writeNested(t, 'd', 'nested', { 'x.txt': 'x\n' });
    await t.write('e/f.txt', 'f\n');
    const [ctx, wt] = [fakeCtx(t.repo), mainWt(t.repo)];
    await expect(reset(ctx, t.dir, one, 'hard', true)).rejects.toMatchObject({ kind: 'InvalidInput', message: 'd is a repository in the way of the reset: move it first' });
    t.memfs.unlinkSync(`${t.dir}/d/.git`);
    expect((await atRisk(wt, 'hard', one)).overwritten).toEqual(['d/x.txt', 'e/f.txt']);
  });

  it('clears a stray merge message, mode and AUTO_MERGE, as git does', async () => {
    const { t, one, ctx, wt } = await repo();
    for (const mode of ['soft', 'mixed', 'hard'] as const) {
      for (const f of ['MERGE_MSG', 'SQUASH_MSG', 'MERGE_MODE', 'AUTO_MERGE']) t.memfs.writeFileSync(`${t.repo.gitdir}/${f}`, `${one}\n`);
      await reset(ctx, t.dir, one, mode, true);
      expect([mode, ['MERGE_MSG', 'SQUASH_MSG', 'MERGE_MODE', 'AUTO_MERGE'].filter((f) => t.memfs.existsSync(`${t.repo.gitdir}/${f}`)), inProgressName(wt.fs, wt.gitdir)]).toEqual([mode, [], null]);
    }
  });

  it('moves a detached HEAD, and refuses a bad id, an unborn branch and a merge in progress', async () => {
    const { t, one, two, ctx, wt } = await repo();
    setHead(wt, { oid: two });
    await reset(ctx, t.dir, one, 'soft');
    expect(readHead(wt)).toEqual({ branch: null, oid: one });
    await expect(reset(ctx, t.dir, one.slice(0, 10), 'soft')).rejects.toMatchObject({ kind: 'InvalidInput', message: `not an object id: ${one.slice(0, 10)}` });
    setHead(wt, { branch: 'nothing-yet' });
    await expect(reset(ctx, t.dir, one, 'soft')).rejects.toMatchObject({ kind: 'InvalidInput', message: 'Nothing is committed on nothing-yet yet' });
    setHead(wt, { branch: 'main' });
    t.memfs.writeFileSync(`${t.repo.gitdir}/MERGE_HEAD`, `${one}\n`);
    await expect(reset(ctx, t.dir, one, 'soft')).rejects.toMatchObject({ kind: 'InProgress', message: 'A merge is in progress' });
  });
});
