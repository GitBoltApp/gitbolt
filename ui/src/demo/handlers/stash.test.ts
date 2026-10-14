import { describe, expect, it, vi } from 'vitest';
import type { AppEvent } from '../../api/gen/AppEvent';
import { fakeCtx, makeTestRepo } from '../engine/read/testkit';
import { runWrite } from '../engine/write/run';
import { mainWt } from '../engine/write/seam';
import { stashList } from '../engine/write/stash';
import { statusEntries } from '../engine/write/status';
import { stashHandlers as h, undoStash } from './stash';
import { NO_EXPECT } from './stage';

/** `fail`: the snapshot after that many more throws (a pop's `before` is 0, its `after` 1). */
const snap = vi.hoisted(() => ({ fail: -1 }));
vi.mock('../engine/write/snapshot', async (load) => {
  const real = await load<typeof import('../engine/write/snapshot')>();
  return {
    ...real,
    createSnapshot: (...args: Parameters<typeof real.createSnapshot>) => {
      if (snap.fail >= 0 && snap.fail-- === 0) return Promise.reject(new Error('no space'));
      return real.createSnapshot(...args);
    },
  };
});

async function repo() {
  const t = await makeTestRepo();
  await t.write('a.txt', '1\n2\n3\n');
  await t.commit('Base');
  await t.write('a.txt', '1\n2\n3\nA\n');
  await t.stage('a.txt');
  await t.write('u.txt', 'u\n');
  return { t, ctx: fakeCtx(t.repo), wt: mainWt(t.repo) };
}
const status = async (t: Awaited<ReturnType<typeof repo>>['t']) => (await statusEntries(t.repo, t.dir)).map((e) => `${e.index}${e.worktree} ${e.path}`);

describe('stash intents', () => {
  it('pushes with a message or WIP on <branch>, and has nothing to stash on a clean tree', async () => {
    const { t, ctx, wt } = await repo();
    const r = await h.stashPush({ repo: 1, worktree: t.dir, message: '' }, ctx);
    expect([r.outcome.status, r.journal.undo?.label, stashList(wt)[0].subject, await status(t)]).toEqual(['stashed', 'stash "WIP on main"', 'On main: WIP on main', []]);
    expect(ctx.writes.journal(t.dir).undoTop()?.stashes).toEqual([{ oid: stashList(wt)[0].oid, message: 'On main: WIP on main', created: true, withoutIndex: false }]);
    const none = await h.stashPush({ repo: 1, worktree: t.dir, message: 'x' }, ctx);
    expect([none.outcome, ctx.writes.journal(t.dir).undo.length]).toEqual([{ status: 'nothingToStash' }, 1]);
  });

  it("lists a multi-line message by its first line, and the relist's guard takes a journal id as the core's does", async () => {
    const { t, ctx, wt } = await repo();
    await h.stashPush({ repo: 1, worktree: t.dir, message: 'Fix x\n\nThe details.' }, ctx);
    const j = ctx.writes.journal(t.dir);
    expect([stashList(wt)[0].subject, j.undoTop()?.id, j.kept, j.nextId]).toEqual(['On main: Fix x', 1, [], 3]);
    await h.stashPush({ repo: 1, worktree: t.dir, message: 'nothing\n\nleft' }, ctx);
    expect(j.nextId).toBe(4);
  });

  it('takes no guard id when the stored subject already reads as the summary', async () => {
    const { t, ctx } = await repo();
    await h.stashPush({ repo: 1, worktree: t.dir, message: 'Fix x\n' }, ctx);
    const before = ctx.writes.journal(t.dir).nextId;
    await t.write('a.txt', '1\n2\n3\nC\n');
    await h.stashPush({ repo: 1, worktree: t.dir, message: 'Fix y' }, ctx);
    expect(ctx.writes.journal(t.dir).nextId).toBe(before + 1);
  });

  it('applies without journaling, pops with snapshots, and drops', async () => {
    const { t, ctx, wt } = await repo();
    await h.stashPush({ repo: 1, worktree: t.dir, message: 'Fix x' }, ctx);
    const oid = stashList(wt)[0].oid;
    const a = await h.stashApply({ repo: 1, worktree: t.dir, oid, pop: false }, ctx);
    expect([a.outcome, a.journal.undo?.label, stashList(wt).length, await status(t)]).toEqual([{ status: 'applied' }, 'stash "Fix x"', 1, ['M. a.txt', '?? u.txt']]);
    await t.checkout('main');
    t.memfs.unlinkSync(`${t.dir}/u.txt`);
    const p = await h.stashApply({ repo: 1, worktree: t.dir, oid, pop: true }, ctx);
    const e = ctx.writes.journal(t.dir).undoTop()!;
    expect([p.outcome, e.label, e.before?.paths, e.after !== null, stashList(wt)]).toEqual([{ status: 'applied' }, 'pop stash "Fix x"', ['a.txt', 'u.txt'], true, []]);
    await expect(h.stashDrop({ repo: 1, worktree: t.dir, oid }, ctx)).rejects.toMatchObject({ kind: 'NotFound', message: 'That stash is gone' });
    await h.stashPush({ repo: 1, worktree: t.dir, message: 'Again' }, ctx);
    const d = await h.stashDrop({ repo: 1, worktree: t.dir, oid: stashList(wt)[0].oid }, ctx);
    expect([d.journal.undo?.label, stashList(wt)]).toEqual(['drop stash "Again"', []]);
  });

  it('asks to apply without the index when its staged part no longer applies', async () => {
    const { t, ctx, wt } = await repo();
    await h.stashPush({ repo: 1, worktree: t.dir, message: 's' }, ctx);
    await t.write('a.txt', '1\n2\nX\n');
    await t.commit('Move line 3');
    const oid = stashList(wt)[0].oid;
    await expect(h.stashApply({ repo: 1, worktree: t.dir, oid, pop: false }, ctx)).rejects.toMatchObject({ kind: 'Conflict', message: "git couldn't restore what was staged", detail: { kind: 'applyWithoutIndex' } });
    const r = await h.stashApply({ repo: 1, worktree: t.dir, oid, pop: false, withoutIndex: true }, ctx);
    expect(r.outcome).toEqual({ status: 'conflicts', files: 1 });
  });

  it('keeps the stash of a conflicting pop, and of a pop with an untracked file in the way', async () => {
    const { t, ctx, wt } = await repo();
    await h.stashPush({ repo: 1, worktree: t.dir, message: 's' }, ctx);
    const oid = stashList(wt)[0].oid;
    await t.write('a.txt', '1\n2\n3\nB\n');
    await t.commit('Add B');
    const c = await h.stashApply({ repo: 1, worktree: t.dir, oid, pop: true, withoutIndex: true }, ctx);
    const e = ctx.writes.journal(t.dir).undoTop()!;
    expect([c.outcome, stashList(wt).length, e.label, e.before !== null, e.after]).toEqual([{ status: 'conflicts', files: 1 }, 1, 'pop stash "s"', true, null]);
    const g = await repo();
    await h.stashPush({ repo: 1, worktree: g.t.dir, message: 's' }, g.ctx);
    await g.t.write('u.txt', 'mine\n');
    await expect(h.stashApply({ repo: 1, worktree: g.t.dir, oid: stashList(g.wt)[0].oid, pop: true }, g.ctx)).rejects.toMatchObject({ message: 'u.txt already exists, no checkout' });
    expect([stashList(g.wt).length, g.ctx.writes.journal(g.t.dir).undoTop()?.label]).toEqual([1, 'pop stash "s"']);
  });

  it('stops restoring untracked files at a file where their folder goes, as git does, keeping it and the stash', async () => {
    for (const pop of [false, true]) {
      const { t, ctx, wt } = await repo();
      await t.write('a0.txt', 'a0\n');
      await t.write('b.txt/inside.txt', 'x\n');
      await t.write('c.txt', 'c\n');
      t.memfs.unlinkSync(`${t.dir}/u.txt`);
      await h.stashPush({ repo: 1, worktree: t.dir, message: 's' }, ctx);
      await t.write('b.txt', 'mine\n');
      const read = (p: string) => (t.memfs.existsSync(`${t.dir}/${p}`) ? t.memfs.readFileSync(`${t.dir}/${p}`, 'utf8') : null);
      await expect(h.stashApply({ repo: 1, worktree: t.dir, oid: stashList(wt)[0].oid, pop }, ctx)).rejects.toMatchObject({
        kind: 'Other',
        message: "cannot create directory at 'b.txt': File exists",
        stderr: "fatal: cannot create directory at 'b.txt': File exists\nerror: could not restore untracked files from stash\n",
      });
      expect([pop, read('b.txt'), read('a0.txt'), read('c.txt'), read('a.txt'), stashList(wt).length]).toEqual([pop, 'mine\n', 'a0\n', null, '1\n2\n3\nA\n', 1]);
    }
  });

  it('names the outermost file in the way, after the files already there, and a .lock one as IndexLocked', async () => {
    const setup = async () => {
      const r = await repo();
      await r.t.write('d/e/f.txt', 'f\n');
      await r.t.write('x.lock/y', 'y\n');
      await h.stashPush({ repo: 1, worktree: r.t.dir, message: 's' }, r.ctx);
      return { ...r, oid: stashList(r.wt)[0].oid };
    };
    const one = await setup();
    await one.t.write('d/e', 'file\n');
    await expect(h.stashApply({ repo: 1, worktree: one.t.dir, oid: one.oid, pop: false }, one.ctx)).rejects.toMatchObject({ kind: 'Other', message: "cannot create directory at 'd/e': File exists" });
    const two = await setup();
    await two.t.write('d/e/f.txt', 'mine\n');
    await two.t.write('u.txt', 'mine\n');
    await two.t.write('x.lock', 'lock\n');
    await expect(h.stashApply({ repo: 1, worktree: two.t.dir, oid: two.oid, pop: false }, two.ctx)).rejects.toMatchObject({
      kind: 'IndexLocked',
      message: 'd/e/f.txt already exists, no checkout',
      stderr: "d/e/f.txt already exists, no checkout\nu.txt already exists, no checkout\nfatal: cannot create directory at 'x.lock': File exists\nerror: could not restore untracked files from stash\n",
    });
  });

  it('refuses a stash or an apply that would write a file over a repository', async () => {
    const { t, ctx, wt } = await repo();
    await t.remove('a.txt');
    await t.write('a.txt/.git/HEAD', 'ref: refs/heads/main\n');
    await expect(h.stashPush({ repo: 1, worktree: t.dir, message: 's' }, ctx)).rejects.toMatchObject({ kind: 'InvalidInput', message: 'a.txt is a repository in the way of the stash: move it first' });
    const g = await repo();
    await h.stashPush({ repo: 1, worktree: g.t.dir, message: 's' }, g.ctx);
    await g.t.write('u.txt/inner/.git/HEAD', 'ref: refs/heads/main\n');
    const oid = stashList(g.wt)[0].oid;
    await expect(h.stashApply({ repo: 1, worktree: g.t.dir, oid, pop: true }, g.ctx)).rejects.toMatchObject({ kind: 'InvalidInput', message: 'u.txt/inner is a repository in the way of the pop: move it first' });
    expect([stashList(wt).length, stashList(g.wt).length, ctx.writes.journal(t.dir).undo.length]).toEqual([0, 1, 0]);
  });

  it("keeps a pop whose after snapshot failed, blocked from its undo", async () => {
    const { t, ctx, wt } = await repo();
    await h.stashPush({ repo: 1, worktree: t.dir, message: 's' }, ctx);
    snap.fail = 1;
    const r = await h.stashApply({ repo: 1, worktree: t.dir, oid: stashList(wt)[0].oid, pop: true }, ctx);
    const e = ctx.writes.journal(t.dir).undoTop()!;
    expect([r.outcome, stashList(wt), e.after, e.blocked]).toEqual([{ status: 'applied' }, [], null, "Can't be undone: GitVolt couldn't record what the pop left"]);
  });

  it("drops a kept autostash's record when its stash is popped", async () => {
    const { t, ctx, wt } = await repo();
    await h.stashPush({ repo: 1, worktree: t.dir, message: 'kept' }, ctx);
    const oid = stashList(wt)[0].oid;
    ctx.writes.journal(t.dir).keep({ oid, message: 'On main: kept', label: 'checkout x', target: 'x', reason: { status: 'refused' }, createdMs: 0 });
    const r = await h.stashApply({ repo: 1, worktree: t.dir, oid, pop: true }, ctx);
    expect([ctx.writes.journal(t.dir).kept, r.journal.banners]).toEqual([[], []]);
  });
});

describe('undoStash', () => {
  const undoWrite = (ctx: ReturnType<typeof fakeCtx>, dir: string, id: number, undo: boolean) =>
    runWrite(ctx, 1, dir, NO_EXPECT, {
      kind: undo ? 'undo' : 'redo',
      label: () => 'undo test',
      undo: () => null,
      run: async (cx) => {
        await undoStash(cx, cx.journal.entry(id)!, undo, 'stash "Fix x"', false);
        return null;
      },
    });

  it("undoes a push by applying and dropping it, and redoes it as a new stash", async () => {
    const { t, ctx, wt } = await repo();
    await h.stashPush({ repo: 1, worktree: t.dir, message: 'Fix x' }, ctx);
    const e = ctx.writes.journal(t.dir).undoTop()!;
    await undoWrite(ctx, t.dir, e.id, true);
    expect([await status(t), stashList(wt)]).toEqual([['M. a.txt', '?? u.txt'], []]);
    await undoWrite(ctx, t.dir, e.id, false);
    expect([await status(t), stashList(wt).length, e.stashes[0].oid]).toEqual([[], 1, stashList(wt)[0].oid]);
  });

  it('undoes a pop by storing the stash back and restoring the files, and a drop by storing it back', async () => {
    const { t, ctx, wt } = await repo();
    await h.stashPush({ repo: 1, worktree: t.dir, message: 'Fix x' }, ctx);
    const oid = stashList(wt)[0].oid;
    await h.stashApply({ repo: 1, worktree: t.dir, oid, pop: true }, ctx);
    const pop = ctx.writes.journal(t.dir).undoTop()!;
    const events: AppEvent[] = [];
    ctx.emit = (e) => void events.push(e);
    const stashTouched = () => events.some((e) => e.type === 'repoChanged' && e.kinds.includes('stash'));
    await undoWrite(ctx, t.dir, pop.id, true);
    expect([await status(t), stashList(wt).map((s) => s.oid), stashTouched()]).toEqual([[], [oid], true]);
    // Retried with the stash still listed: nothing is stored, so the stash list didn't change.
    events.length = 0;
    await undoWrite(ctx, t.dir, pop.id, true);
    expect([stashList(wt).length, stashTouched()]).toEqual([1, false]);
    await h.stashDrop({ repo: 1, worktree: t.dir, oid }, ctx);
    const drop = ctx.writes.journal(t.dir).undoTop()!;
    await undoWrite(ctx, t.dir, drop.id, true);
    expect(stashList(wt)).toEqual([{ oid, subject: 'On main: Fix x' }]);
  });
});
