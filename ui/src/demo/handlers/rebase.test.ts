import { describe, expect, it } from 'vitest';
import { readCommit } from '../engine/read/commitText';
import { makeTestRepo } from '../engine/read/testkit';
import { readInProgress, NO_EXPECT } from '../engine/writeSeam';
import { openForWrite } from '../engine/writeSeamTest';
import { rebaseIntegrate } from '../engine/seq/rebase';
import { pushedDev, rebaseLab, stackShape, subjects } from '../engine/seq/fixtures';
import { rewordCommit } from '../engine/seq/irebase';
import { rewrittenOf } from '../engine/seq/rewrites';
import { rebaseHandlers } from './rebase';

describe('rewrite marks after a rebase', () => {
  const ask = { target: 'main', expect: NO_EXPECT, confirm: { autostash: false } };

  it('a plain rebase of a pushed branch marks it', async () => {
    const t = await makeTestRepo();
    await pushedDev(t);
    const { ctx, id, wt } = await openForWrite(t);
    await rebaseIntegrate(ctx, { repo: id, worktree: wt, ...ask });
    expect(await rewrittenOf(t.repo, 'dev')).toEqual({ kind: 'rebase', remote: 'origin' });
  });

  it('rewording an older commit of a pushed branch marks it', async () => {
    const t = await makeTestRepo();
    await pushedDev(t);
    const { ctx, id, wt } = await openForWrite(t);
    await rewordCommit(ctx, { repo: id, worktree: wt, oid: (await readCommit(t.repo, await t.rev('dev'))).parents[0], message: 'D1, reworded\n', expect: { head: null, refs: {} }, confirm: { autostash: false } });
    expect(await rewrittenOf(t.repo, 'dev')).toEqual({ kind: 'rebase', remote: 'origin' });
  });

  it('a conflicted rebase marks the branch once Continue completes it, and not while paused', async () => {
    const t = await makeTestRepo();
    await pushedDev(t, true);
    const { ctx, id, wt } = await openForWrite(t);
    const first = await rebaseIntegrate(ctx, { repo: id, worktree: wt, ...ask });
    expect(first.outcome.status).toBe('stopped');
    expect(await rewrittenOf(t.repo, 'dev')).toBeNull();
    await t.write('notes.txt', 'one\ntwo, both\nthree\n');
    await t.stage('notes.txt');
    const done = await rebaseHandlers.rebaseControl({ repo: id, worktree: wt, action: 'continue' }, ctx);
    expect(done.outcome).toMatchObject({ status: 'done' });
    expect(await rewrittenOf(t.repo, 'dev')).toEqual({ kind: 'rebase', remote: 'origin' });
  });
});

describe('rebase controls', () => {
  it('continue finishes a stopped rebase; abort puts the branch back', async () => {
    const t = await makeTestRepo();
    await rebaseLab(t);
    const before = await t.rev('lab');
    const { ctx, id, wt } = await openForWrite(t);
    await rebaseIntegrate(ctx, { repo: id, worktree: wt, target: 'main', expect: NO_EXPECT, confirm: { autostash: false } });
    await t.write('notes.txt', 'one\ntwo, both\nthree\n');
    await t.stage('notes.txt');
    const done = await rebaseHandlers.rebaseControl({ repo: id, worktree: wt, action: 'continue' }, ctx);
    expect(done.outcome).toEqual({ status: 'done', commits: 6, fastForward: false });
    expect(done.journal.paused).toBeNull();
    expect(await subjects(t, 'main', 'lab')).toHaveLength(6);

    expect(await t.rev('lab')).not.toBe(before);

    const t2 = await makeTestRepo();
    await rebaseLab(t2);
    const before2 = await t2.rev('lab');
    const w2 = await openForWrite(t2);
    await rebaseIntegrate(w2.ctx, { repo: w2.id, worktree: w2.wt, target: 'main', expect: NO_EXPECT, confirm: { autostash: false } });
    const aborted = await rebaseHandlers.rebaseControl({ repo: w2.id, worktree: w2.wt, action: 'abort' }, w2.ctx);
    expect(aborted.outcome).toEqual({ status: 'aborted' });
    expect(aborted.journal.paused).toBeNull();
    expect(await t2.rev('lab')).toBe(before2);
    expect(readInProgress(t2.memfs, t2.repo.gitdir)).toBeNull();
  });

  it('skip leaves the stopped commit out; an unresolved Continue stays paused', async () => {
    const t = await makeTestRepo();
    await rebaseLab(t);
    const { ctx, id, wt } = await openForWrite(t);
    const first = await rebaseIntegrate(ctx, { repo: id, worktree: wt, target: 'main', expect: NO_EXPECT, confirm: { autostash: false } });
    expect(first.outcome.status).toBe('stopped');
    const again = await rebaseHandlers.rebaseControl({ repo: id, worktree: wt, action: 'continue' }, ctx);
    expect(again.outcome).toMatchObject({ status: 'stopped', kind: 'rebase' });
    expect(again.journal.paused).not.toBeNull();
    const skipped = await rebaseHandlers.rebaseControl({ repo: id, worktree: wt, action: 'skip' }, ctx);
    expect(skipped.outcome).toEqual({ status: 'done', commits: 5, fastForward: false });
    expect(skipped.journal.paused).toBeNull();
    expect(readInProgress(t.memfs, t.repo.gitdir)).toBeNull();
  });

  it('a Continue that stops on a refused step carries the core warning', async () => {
    const t = await makeTestRepo();
    await t.write('a.txt', 'one\n');
    await t.commit('Base');
    await t.branch('lab');
    await t.write('a.txt', 'one, main\n');
    await t.commit('Main');
    await t.checkout('lab');
    await t.write('n.txt', 'n\n');
    await t.commit('Add n');
    await t.remove('n.txt');
    await t.commit('Remove n');
    await t.write('a.txt', 'one, lab\n');
    await t.commit('Edit a');
    await t.write('n.txt', 'mine\n');
    const { ctx, id, wt } = await openForWrite(t);
    const first = await rebaseIntegrate(ctx, { repo: id, worktree: wt, target: 'main', expect: NO_EXPECT, confirm: { autostash: false } });
    expect(first.outcome).toMatchObject({ status: 'stopped', files: 0, warning: expect.stringMatching(/^The rebase stopped: /) });
    const again = await rebaseHandlers.rebaseControl({ repo: id, worktree: wt, action: 'continue' }, ctx);
    expect(again.outcome).toMatchObject({ status: 'stopped', files: 0, warning: expect.stringMatching(/^The rebase stopped: /) });
  });

  it('Continue commits with a typed message; a blank one keeps the stored message', async () => {
    const run = async (message: string | undefined) => {
      const t = await makeTestRepo();
      await rebaseLab(t);
      const { ctx, id, wt } = await openForWrite(t);
      await rebaseIntegrate(ctx, { repo: id, worktree: wt, target: 'main', expect: NO_EXPECT, confirm: { autostash: false } });
      await t.write('notes.txt', 'one\ntwo, both\nthree\n');
      await t.stage('notes.txt');
      await rebaseHandlers.rebaseControl({ repo: id, worktree: wt, action: 'continue', message }, ctx);
      return subjects(t, 'main', 'lab');
    };
    const typed = await run('Typed subject');
    expect(typed).toContain('Typed subject');
    expect(typed).not.toContain('L2 Reword line two');
    const blank = await run('   ');
    expect(blank).toContain('L2 Reword line two');
  });

  it('refuses a control with no rebase in progress', async () => {
    const t = await makeTestRepo();
    await stackShape(t);
    const { ctx, id, wt } = await openForWrite(t);
    await expect(rebaseHandlers.rebaseControl({ repo: id, worktree: wt, action: 'skip' }, ctx)).rejects.toMatchObject({ kind: 'InvalidInput', message: 'No rebase is in progress' });
  });
});
