import { describe, expect, it } from 'vitest';
import type { AppEvent } from '../../../api/gen/AppEvent';
import { fakeCtx, makeTestRepo } from '../read/testkit';
import { checkoutHandlers } from '../../handlers/checkout';
import { journalHandlers } from '../../handlers/journal';
import { mergeHandlers } from '../../handlers/merge';
import { planAutostash, type AutostashRule } from './autostash';
import { mainWt } from './seam';
import { stashList } from './stash';
import { statusEntries } from './status';

const NO = { head: null, refs: {} };
const lines = (n: number, edits: Record<number, string> = {}) => Array.from({ length: n }, (_, i) => `${edits[i + 1] ?? `line ${i + 1}`}\n`).join('');

/** main: a.txt (12 lines), b.txt, d.txt (20 lines). feature: d.txt's line 20 and a.txt's line 1 changed. */
async function repo() {
  const t = await makeTestRepo();
  await t.write('a.txt', lines(12));
  await t.write('b.txt', 'b\n');
  await t.write('d.txt', lines(20));
  const base = await t.commit('Base');
  await t.branch('feature', base);
  await t.checkout('feature');
  await t.write('a.txt', lines(12, { 1: 'feature' }));
  await t.write('d.txt', lines(20, { 20: 'feature' }));
  await t.commit('Feature');
  await t.checkout('main');
  const ctx = fakeCtx(t.repo);
  const events: AppEvent[] = [];
  ctx.emit = (e: AppEvent) => void events.push(e);
  return { t, ctx, events, wt: mainWt(t.repo) };
}
const status = async (t: Awaited<ReturnType<typeof repo>>['t']) => (await statusEntries(t.repo, t.dir)).map((e) => `${e.index}${e.worktree} ${e.path}`);
const co = (ctx: ReturnType<typeof fakeCtx>, dir: string, confirmAutostash = false) => checkoutHandlers.checkout({ repo: 1, worktree: dir, target: { kind: 'branch', name: 'feature' }, expect: NO, confirmAutostash }, ctx);

describe('the autostash', () => {
  it("doesn't stash when nothing dirty is touched", async () => {
    const { t, ctx, events, wt } = await repo();
    await t.write('b.txt', 'mine\n');
    const mtime = t.memfs.lstatSync(`${t.dir}/b.txt`).mtimeMs;
    await co(ctx, t.dir);
    expect([t.memfs.lstatSync(`${t.dir}/b.txt`).mtimeMs, stashList(wt), events.some((e) => e.type === 'opStashStep')]).toEqual([mtime, [], false]);
  });

  it('stashes an overlap and brings the staged split back', async () => {
    const { t, ctx, events, wt } = await repo();
    await t.write('a.txt', lines(12, { 12: 'staged' }));
    await t.stage('a.txt');
    await t.write('a.txt', lines(12, { 6: 'unstaged', 12: 'staged' }));
    await t.write('c.txt', 'untracked\n');
    const before = await status(t);
    await co(ctx, t.dir);
    expect([await status(t), stashList(wt), ctx.writes.journal(t.dir).kept]).toEqual([before, [], []]);
    expect(t.memfs.readFileSync(`${t.dir}/a.txt`, 'utf8')).toBe(lines(12, { 1: 'feature', 6: 'unstaged', 12: 'staged' }));
    expect(events.filter((e) => e.type === 'opStashStep').map((e) => (e as { step: string | null }).step)).toEqual(['saving', null, 'restoring', null, 'restoring', null]);
  });

  it('asks first when the restore would conflict, then keeps the stash with a banner', async () => {
    const { t, ctx, wt } = await repo();
    await t.write('d.txt', lines(20, { 20: 'mine' }));
    await expect(co(ctx, t.dir)).rejects.toMatchObject({ kind: 'Conflict', message: 'Your changes conflict with feature', detail: { kind: 'autostashConflict', paths: ['d.txt'], target: 'feature' } });
    expect([await status(t), stashList(wt)]).toEqual([['.M d.txt'], []]);
    const r = await co(ctx, t.dir, true);
    expect(r.journal.banners).toEqual([{ entry: expect.any(Number), kind: 'autostashConflicts', label: 'checkout feature', stash: stashList(wt)[0].oid, stashMessage: 'autostash before checkout feature', target: 'feature', snapshot: false, files: 1, canDrop: true, binary: false }]);
    const kept = r.journal.banners[0].entry;
    const state = await journalHandlers.dismissBanner({ repo: 1, worktree: t.dir, entry: kept, dropStash: true }, ctx);
    expect([state.banners, stashList(wt)]).toEqual([[], []]);
  });

  it('keeps a merge autostash paused until the merge ends', async () => {
    const { t, ctx, wt } = await repo();
    await t.write('a.txt', lines(12, { 1: 'main' }));
    await t.commit('Main a');
    await t.write('b.txt', 'mine\n');
    const r = await mergeHandlers.integrate({ repo: 1, worktree: t.dir, kind: 'merge', target: 'feature', expect: NO, confirm: { autostash: false } }, ctx);
    expect([r.outcome, ctx.writes.journal(t.dir).kept.map((k) => k.reason.status), r.journal.banners, stashList(wt).length]).toEqual([{ status: 'stopped', kind: 'merge', files: 1 }, ['paused'], [], 1]);
    await mergeHandlers.mergeAbort({ repo: 1, worktree: t.dir }, ctx);
    expect([await status(t), ctx.writes.journal(t.dir).kept, stashList(wt)]).toEqual([['.M b.txt'], [], []]);
  });
  it("asks when the staged part wouldn't apply to the target, then applies the kept stash without it", async () => {
    const { t, ctx, wt } = await repo();
    await t.write('a.txt', lines(12, { 3: 'staged' }));
    await t.stage('a.txt');
    await expect(co(ctx, t.dir)).rejects.toMatchObject({ kind: 'Conflict', detail: { kind: 'autostashConflict', paths: ['a.txt'], target: 'feature' } });
    const r = await co(ctx, t.dir, true);
    const [banner] = r.journal.banners;
    expect([banner.kind, await status(t), stashList(wt).length]).toEqual(['autostashRefused', [], 1]);
    const apply = (withoutIndex: boolean) => journalHandlers.applyKeptStash({ repo: 1, worktree: t.dir, entry: banner.entry, withoutIndex }, ctx);
    await expect(apply(false)).rejects.toMatchObject({ kind: 'Conflict', message: "git couldn't restore what was staged", detail: { kind: 'applyWithoutIndex' } });
    expect(ctx.writes.journal(t.dir).kept.map((k) => k.reason.status)).toEqual(['refused']);
    const done = await apply(true);
    expect([done.journal.banners, stashList(wt), await status(t), done.journal.undo?.label]).toEqual([[], [], ['.M a.txt'], 'checkout feature']);
    expect(t.memfs.readFileSync(`${t.dir}/a.txt`, 'utf8')).toBe(lines(12, { 1: 'feature', 3: 'staged' }));
  });

  it('keeps the stash when an untracked file of it is in the way, and lets the banner go without dropping it', async () => {
    const { t, ctx, events, wt } = await repo();
    await t.checkout('feature');
    await t.write('c.txt', 'theirs\n');
    await t.commit('Add c');
    await t.checkout('main');
    await t.write('b.txt', 'mine\n');
    await t.write('c.txt', 'untracked\n');
    await expect(co(ctx, t.dir)).rejects.toMatchObject({ detail: { kind: 'autostashConflict', paths: ['c.txt'] } });
    const r = await co(ctx, t.dir, true);
    const [banner] = r.journal.banners;
    // As git leaves it: the tracked changes back, the untracked file only in the stash.
    expect([banner.kind, banner.canDrop, await status(t), t.memfs.readFileSync(`${t.dir}/c.txt`, 'utf8')]).toEqual(['autostashPartial', false, ['.M b.txt'], 'theirs\n']);
    await expect(journalHandlers.dismissBanner({ repo: 1, worktree: t.dir, entry: banner.entry, dropStash: true }, ctx)).rejects.toMatchObject({ kind: 'InvalidInput', message: 'Apply the stash first: it holds the only copy of some of those changes' });
    events.length = 0;
    const state = await journalHandlers.dismissBanner({ repo: 1, worktree: t.dir, entry: banner.entry }, ctx);
    expect([state.banners, stashList(wt).length, events.map((e) => e.type)]).toEqual([[], 1, ['journalChanged']]);
    await expect(journalHandlers.applyKeptStash({ repo: 1, worktree: t.dir, entry: banner.entry }, ctx)).rejects.toMatchObject({ kind: 'Stale', message: 'That notice is gone; refreshed' });
  });

  it("predicts a merge against its result, not the target: HEAD's own change isn't a conflict", async () => {
    const { t, ctx, wt } = await repo();
    await t.write('b.txt', 'main\n');
    await t.commit('Main b');
    await t.write('b.txt', 'main, mine\n');
    const r = await mergeHandlers.integrate({ repo: 1, worktree: t.dir, kind: 'merge', target: 'feature', expect: NO, confirm: { autostash: false } }, ctx);
    expect([r.outcome, await status(t), stashList(wt), r.journal.banners]).toEqual([{ status: 'done', commits: 2, fastForward: false }, ['.M b.txt'], [], []]);
  });

  it("refuses a banner's action while its merge is paused", async () => {
    const { t, ctx } = await repo();
    await t.write('a.txt', lines(12, { 1: 'main' }));
    await t.commit('Main a');
    await t.write('b.txt', 'mine\n');
    await mergeHandlers.integrate({ repo: 1, worktree: t.dir, kind: 'merge', target: 'feature', expect: NO, confirm: { autostash: false } }, ctx);
    const [kept] = ctx.writes.journal(t.dir).kept;
    const wait = { kind: 'InvalidInput', message: 'That stash waits for the merge or rebase to finish' };
    await expect(journalHandlers.applyKeptStash({ repo: 1, worktree: t.dir, entry: kept.id }, ctx)).rejects.toMatchObject(wait);
    await expect(journalHandlers.dismissBanner({ repo: 1, worktree: t.dir, entry: kept.id }, ctx)).rejects.toMatchObject(wait);
  });

  it("anyTracked, rebased and touching need a stash as the core's rules say", async () => {
    const { t, wt } = await repo();
    const feature = await t.rev('feature');
    const spec = (rule: AutostashRule, target: string | null = feature) => planAutostash(wt, { rule, target, op: 'rebase', targetName: 'feature' });
    // An untracked file nothing touches: no rule stashes for it.
    await t.write('z.txt', 'untracked\n');
    expect([await spec({ kind: 'overlap' }), await spec({ kind: 'anyTracked' }), await spec({ kind: 'touching', paths: ['d/x.txt'] }, null)]).toEqual([null, null, null]);
    // A tracked change the target doesn't touch: only the overlap rule lets git carry it.
    await t.write('b.txt', 'mine\n');
    expect(await spec({ kind: 'overlap' })).toBeNull();
    expect(await spec({ kind: 'anyTracked' })).toEqual({ message: 'autostash before rebase', target: 'feature', conflicts: [], pathspec: null, all: false });
    await t.write('b.txt', 'b\n');
    // touching: an untracked file where a pick puts a folder.
    await t.write('d', 'in the way\n');
    expect(await spec({ kind: 'touching', paths: ['d/x.txt'] }, null)).toMatchObject({ conflicts: [], pathspec: null });
  });

  it('rebased also stashes an untracked file where the target itself has one, though their merge has none', async () => {
    const t = await makeTestRepo();
    await t.write('a.txt', 'a\n');
    await t.write('e.txt', 'e\n');
    const base = await t.commit('Base');
    await t.branch('feature', base);
    await t.remove('e.txt');
    await t.commit('Drop e');
    await t.write('e.txt', 'mine\n');
    const wt = mainWt(t.repo);
    const feature = await t.rev('feature');
    const spec = (kind: 'merged' | 'rebased') => planAutostash(wt, { rule: { kind }, target: feature, op: 'rebase', targetName: 'feature' });
    expect(await spec('merged')).toBeNull();
    expect(await spec('rebased')).toMatchObject({ message: 'autostash before rebase', pathspec: null });
  });
});
