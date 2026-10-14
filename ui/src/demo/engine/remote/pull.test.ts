import { describe, expect, it } from 'vitest';
import type { PullMode } from '../../../api/gen/PullMode';
import { NO_EXPECT } from '../writeSeam';
import { makeTestRepo } from '../read/testkit';
import { openForWrite } from '../writeSeamTest';
import { checkoutHandlers } from '../../handlers/checkout';
import { undoHandlers } from '../../handlers/undo';
import { remoteHandlers } from '../../handlers/remotes';
import { netOf } from './network';
import { commitInOrigin, withOrigin } from './testkit';

const pull = (p: { repo: number; worktree: string; branch?: string; mode: PullMode }, ctx: Parameters<typeof remoteHandlers.pull>[1]) => remoteHandlers.pull({ expect: NO_EXPECT, confirm: { autostash: false }, ...p }, ctx);

async function setup() {
  const t = await makeTestRepo();
  await t.write('a.txt', 'one\ntwo\nthree\n');
  await t.commit('Base');
  await t.branch('dev');
  const origin = await withOrigin(t, ['main', 'dev']);
  const w = await openForWrite(t);
  netOf(w.ctx).latencyMs = 0;
  return { t, origin, ...w };
}
const trackingLog = (t: Awaited<ReturnType<typeof makeTestRepo>>, ref: string) =>
  (t.memfs.readFileSync(`${t.repo.gitdir}/logs/${ref}`, 'utf8') as string).trimEnd().split('\n').map((l) => l.split('\t')[1]);

describe('pull', () => {
  it('fast-forwards the checked-out branch, then is up to date', async () => {
    const { t, origin, ctx, id, wt } = await setup();
    const theirs = await commitInOrigin(t, origin, 'main', 'r.txt', 'r\n', 'Remote change');
    const r = await pull({ repo: id, worktree: wt, mode: 'ffOnly' }, ctx);
    expect(r.outcome).toMatchObject({ branch: 'main', upstream: 'origin/main', result: { status: 'fastForward', commits: 1 } });
    expect(await t.rev('main')).toBe(theirs);
    expect(await t.memfs.promises.readFile(`${t.dir}/r.txt`, 'utf8')).toBe('r\n');
    expect(r.journal.undo?.label).toBe('pull main');
    // The core's own `git merge --ff-only` (sync.rs), not `run_merge`: no State change.
    expect(ctx.events.find((e) => e.type === 'repoChanged')).toMatchObject({ kinds: ['worktree', 'index', 'refs', 'head'] });
    expect((await pull({ repo: id, worktree: wt, mode: 'ffOnly' }, ctx)).outcome.result).toEqual({ status: 'upToDate', ahead: 0 });
  });

  it("a branch that isn't checked out moves by its ref only, and only by a fast-forward", async () => {
    const { t, origin, ctx, id, wt } = await setup();
    const theirs = await commitInOrigin(t, origin, 'dev', 'd.txt', 'd\n', 'Remote dev');
    const r = await pull({ repo: id, worktree: wt, branch: 'dev', mode: 'ffOnly' }, ctx);
    expect(r.outcome.result).toEqual({ status: 'fastForward', commits: 1 });
    expect(await t.rev('dev')).toBe(theirs);
    await expect(pull({ repo: id, worktree: wt, branch: 'dev', mode: 'rebase' }, ctx)).rejects.toMatchObject({ message: 'Check out dev first' });
  });

  it('diverged: ffOnly reports it, merge merges, rebase rebases', async () => {
    for (const [mode, status] of [['ffOnly', 'diverged'], ['ffOrMerge', 'merged'], ['rebase', 'rebased']] as const) {
      const { t, origin, ctx, id, wt } = await setup();
      await commitInOrigin(t, origin, 'main', 'r.txt', 'r\n', 'Remote change');
      await t.write('l.txt', 'l\n');
      await t.commit('Local change');
      const r = await pull({ repo: id, worktree: wt, mode }, ctx);
      expect(r.outcome.result.status).toBe(status);
      if (mode === 'ffOnly') expect(r.outcome.result).toEqual({ status: 'diverged', ahead: 1, behind: 1, conflicts: 0 });
    }
  });

  it('a conflicted rebase pull pauses on the upstream', async () => {
    const { t, origin, ctx, id, wt } = await setup();
    await commitInOrigin(t, origin, 'main', 'a.txt', 'one\nTWO\nthree\n', 'Remote edits two');
    await t.write('a.txt', 'one\n2\nthree\n');
    await t.commit('Local edits two');
    const r = await pull({ repo: id, worktree: wt, mode: 'rebase' }, ctx);
    expect(r.outcome.result).toEqual({ status: 'stopped', kind: 'rebase', files: 1 });
    expect(r.journal.paused).toMatchObject({ kind: 'rebase', target: 'origin/main' });
  });

  it('no upstream is refused before anything runs', async () => {
    const { t, ctx, id, wt } = await setup();
    await t.branch('lonely');
    await t.checkout('lonely');
    await expect(pull({ repo: id, worktree: wt, mode: 'ffOnly' }, ctx)).rejects.toMatchObject({ message: 'lonely has no upstream; set one from Push ▾' });
    expect(ctx.events.some((e) => e.type === 'opStarted')).toBe(false);
  });

  it("the fetch is outside the entry: the tracking ref moves, the entry names the local branch only, and its Undo rewinds that alone", async () => {
    const { t, origin, ctx, id, wt } = await setup();
    const base = await t.rev('main');
    const theirs = await commitInOrigin(t, origin, 'main', 'r.txt', 'r\n', 'Remote change');
    const from = ctx.events.length;
    await pull({ repo: id, worktree: wt, mode: 'ffOnly' }, ctx);
    expect(await t.rev('refs/remotes/origin/main')).toBe(theirs);
    expect(ctx.writes.journal(t.dir).undo[0].refs.map((m) => m.name)).toEqual(['refs/heads/main']);
    const seen = ctx.events.slice(from).filter((e) => e.type !== 'queueChanged').map((e) => e.type);
    expect(seen.slice(0, 2)).toEqual(['opStarted', 'refsUpdated']);
    expect(seen.at(-1)).toBe('opFinished');
    expect(trackingLog(t, 'refs/remotes/origin/main').at(-1)).toMatch(/^fetch origin --prune --no-prune-tags --progress: fast-forward$/);
    await undoHandlers.undo({ repo: id, worktree: wt, entry: ctx.writes.journal(t.dir).undoTop()!.id }, ctx);
    expect(await t.rev('main')).toBe(base);
    expect(await t.rev('refs/remotes/origin/main')).toBe(theirs);
  });

  it('a pull with dirty files autostashes and restores them', async () => {
    const { t, origin, ctx, id, wt } = await setup();
    await commitInOrigin(t, origin, 'main', 'r.txt', 'r\n', 'Remote change');
    await t.write('a.txt', 'one\ntwo\nthree\nfour\n');
    await t.commit('Local change');
    await t.write('a.txt', 'dirty\none\ntwo\nthree\nfour\n');
    const r = await pull({ repo: id, worktree: wt, mode: 'rebase' }, ctx);
    expect(r.outcome.result.status).toBe('rebased');
    expect(await t.memfs.promises.readFile(`${t.dir}/a.txt`, 'utf8')).toBe('dirty\none\ntwo\nthree\nfour\n');
    expect(await t.memfs.promises.readFile(`${t.dir}/r.txt`, 'utf8')).toBe('r\n');
    expect(ctx.repos.get(id).stashes()).toHaveLength(0);
  });

  it('a fast-forward carries a dirty file that does not overlap, with no stash', async () => {
    const { t, origin, ctx, id, wt } = await setup();
    await commitInOrigin(t, origin, 'main', 'r.txt', 'r\n', 'Remote change');
    await t.write('a.txt', 'dirty\n');
    const r = await pull({ repo: id, worktree: wt, mode: 'ffOnly' }, ctx);
    expect(r.outcome.result).toMatchObject({ status: 'fastForward' });
    expect(await t.memfs.promises.readFile(`${t.dir}/a.txt`, 'utf8')).toBe('dirty\n');
    expect(ctx.events.some((e) => e.type === 'opStashStep')).toBe(false);
  });

  it('a rejected fetch fails the write unjournaled and changes nothing', async () => {
    const { t, ctx, id, wt } = await setup();
    const main = await t.rev('main');
    const { default: git } = await import('isomorphic-git');
    await git.setConfig({ fs: t.memfs, dir: t.dir, path: 'remote.origin.url', value: 'https://git.example.invalid/x.git' });
    await expect(pull({ repo: id, worktree: wt, mode: 'ffOnly' }, ctx)).rejects.toMatchObject({ message: expect.stringContaining('Not in the demo') });
    expect(await t.rev('main')).toBe(main);
    expect(ctx.writes.journal(t.dir).undo).toEqual([]);
    expect(ctx.events.filter((e) => e.type === 'opFinished').at(-1)).toMatchObject({ outcome: 'failed' });
    // The queue goes on: a later write isn't stuck behind it.
    await expect(pull({ repo: id, worktree: wt, branch: 'dev', mode: 'ffOnly' }, ctx)).rejects.toMatchObject({ message: expect.stringContaining('Not in the demo') });
  });

  it("a pull's transfer holds the queue slot, not the write lock", async () => {
    const { t, origin, ctx, id, wt } = await setup();
    await commitInOrigin(t, origin, 'main', 'r.txt', 'r\n', 'Remote change');
    netOf(ctx).latencyMs = 50;
    let done = false;
    const pending = pull({ repo: id, worktree: wt, mode: 'ffOnly' }, ctx).then(() => (done = true));
    await new Promise((r) => setTimeout(r, 10));
    const release = await Promise.race([ctx.writes.queue(id, ctx.emit).lock(), new Promise<null>((r) => setTimeout(() => r(null), 20))]);
    expect(release).not.toBeNull();
    release!();
    expect(done).toBe(false);
    await pending;
    expect(done).toBe(true);
  });

  it('the undo kind follows the checkout a queued write made first', async () => {
    const { t, origin, ctx, id, wt } = await setup();
    const theirs = await commitInOrigin(t, origin, 'dev', 'd.txt', 'd\n', 'Remote dev');
    // Asked while dev isn't checked out; by its turn the queued checkout has made it so.
    const co = checkoutHandlers.checkout({ repo: id, worktree: wt, target: { kind: 'branch', name: 'dev' }, expect: NO_EXPECT }, ctx);
    const p = pull({ repo: id, worktree: wt, branch: 'dev', mode: 'ffOnly' }, ctx);
    await co;
    const r = await p;
    expect(r.outcome.result).toMatchObject({ status: 'fastForward' });
    expect(await t.rev('dev')).toBe(theirs);
    expect(ctx.writes.journal(t.dir).undoTop()).toMatchObject({ label: 'pull dev', undo: 'rewind' });
  });
});
