import * as git from 'isomorphic-git';
import { describe, expect, it } from 'vitest';
import { makeTestRepo } from '../read/testkit';
import { openForWrite } from '../writeSeamTest';
import { HANDLERS } from '../../handlers';
import { remoteHandlers } from '../../handlers/remotes';
import { netOf } from './network';
import { commitInOrigin, withOrigin } from './testkit';
import { COMPARE_REFS, mapRef, parseRefspec } from './transfer';

async function setup() {
  const t = await makeTestRepo();
  await t.write('a.txt', 'a\n');
  await t.commit('Base');
  const origin = await withOrigin(t, ['main']);
  const w = await openForWrite(t);
  netOf(w.ctx).latencyMs = 0;
  return { t, origin, ...w };
}

const reflog = (t: Awaited<ReturnType<typeof makeTestRepo>>, ref: string) =>
  (t.memfs.readFileSync(`${t.repo.gitdir}/logs/${ref}`, 'utf8') as string).trimEnd().split('\n').map((l) => l.split('\t')[1]);

describe('fetch', () => {
  it('maps refspecs', () => {
    const s = parseRefspec('+refs/heads/*:refs/remotes/origin/*');
    expect(s.force).toBe(true);
    expect(mapRef(s, 'refs/heads/feature/ünï')).toBe('refs/remotes/origin/feature/ünï');
    expect(mapRef(s, 'refs/tags/v1')).toBeNull();
    expect(mapRef(parseRefspec('refs/heads/main:refs/remotes/origin/main'), 'refs/heads/main')).toBe('refs/remotes/origin/main');
  });

  it('brings in someone else\'s commit, announces it, and records the op', async () => {
    const { t, origin, ctx, id } = await setup();
    const theirs = await commitInOrigin(t, origin, 'main', 'b.txt', 'b\n', 'Remote change');
    const r = await remoteHandlers.fetch({ repo: id, background: false }, ctx);
    expect(r).toMatchObject({ status: 'done', changed: true, server: { lines: 0, warning: null } });
    expect(await t.rev('refs/remotes/origin/main')).toBe(theirs);
    const kinds = ctx.events.map((e) => e.type);
    expect(kinds).toEqual(expect.arrayContaining(['opStarted', 'refsUpdated', 'opFinished']));
    expect(kinds.filter((k) => k === 'opStarted' || k === 'refsUpdated' || k === 'opFinished')).toEqual(['opStarted', 'refsUpdated', 'opFinished']);
    const finished = ctx.events.find((e) => e.type === 'opFinished');
    expect(finished).toEqual({ type: 'opFinished', op: (r as { op: number }).op, kind: 'fetch', repo: id, outcome: 'ok', message: null, command: 'git fetch --prune --no-prune-tags --progress --all' });
    // git's reflog names the command it ran (one remote: in-process).
    expect(reflog(t, 'refs/remotes/origin/main').at(-1)).toBe('fetch --prune --no-prune-tags --progress --all: fast-forward');
    const again = await remoteHandlers.fetch({ repo: id, background: false }, ctx);
    expect(again).toMatchObject({ status: 'done', changed: false });
  });

  it('prunes a branch the origin deleted, and follows a tag into the fetched history', async () => {
    const { t, origin, ctx, id } = await setup();
    await git.writeRef({ fs: t.memfs, dir: t.dir, ref: 'refs/remotes/origin/gone', value: await t.rev('main') });
    const theirs = await commitInOrigin(t, origin, 'main', 'c.txt', 'c\n', 'Tagged');
    await git.writeRef({ fs: t.memfs, gitdir: origin, ref: 'refs/tags/v9', value: theirs });
    await remoteHandlers.fetch({ repo: id, background: false }, ctx);
    await expect(t.rev('refs/remotes/origin/gone')).rejects.toBeTruthy();
    expect(await t.rev('refs/tags/v9')).toBe(theirs);
  });

  it('follows a tag on a commit already here, never one outside what it has, and never moves a tag', async () => {
    const { t, origin, ctx, id } = await setup();
    const base = await t.rev('main');
    await git.writeRef({ fs: t.memfs, gitdir: origin, ref: 'refs/tags/old', value: base });
    const side = await commitInOrigin(t, origin, 'main', 's.txt', 's\n', 'Side');
    await git.writeRef({ fs: t.memfs, gitdir: origin, ref: 'refs/other/side', value: side });
    await git.writeRef({ fs: t.memfs, gitdir: origin, ref: 'refs/heads/main', value: base, force: true });
    await git.writeRef({ fs: t.memfs, gitdir: origin, ref: 'refs/tags/side', value: side });
    await git.writeRef({ fs: t.memfs, dir: t.dir, ref: 'refs/tags/mine', value: base });
    await git.writeRef({ fs: t.memfs, gitdir: origin, ref: 'refs/tags/mine', value: side });
    const r = await remoteHandlers.fetch({ repo: id, background: false }, ctx);
    expect(r).toMatchObject({ status: 'done', changed: true });
    expect(await t.rev('refs/tags/old')).toBe(base);
    await expect(t.rev('refs/tags/side')).rejects.toBeTruthy();
    expect(await t.rev('refs/tags/mine')).toBe(base);
  });

  it('writes git\'s reflog lines: a new branch, a fast-forward and a forced update', async () => {
    const { t, origin, ctx, id } = await setup();
    const base = await t.rev('main');
    await git.writeRef({ fs: t.memfs, gitdir: origin, ref: 'refs/heads/forced', value: base });
    await commitInOrigin(t, origin, 'forced', 'f.txt', 'f\n', 'Forced');
    await remoteHandlers.fetch({ repo: id, background: false, remote: 'origin' }, ctx);
    await git.writeRef({ fs: t.memfs, gitdir: origin, ref: 'refs/heads/forced', value: base, force: true });
    const elsewhere = await commitInOrigin(t, origin, 'forced', 'g.txt', 'g\n', 'Elsewhere');
    await git.writeRef({ fs: t.memfs, gitdir: origin, ref: 'refs/heads/feature/ünï', value: elsewhere });
    await commitInOrigin(t, origin, 'main', 'b.txt', 'b\n', 'Remote change');
    await remoteHandlers.fetch({ repo: id, background: false, remote: 'origin' }, ctx);
    const argv = 'fetch --prune --no-prune-tags --progress --end-of-options origin';
    expect(reflog(t, 'refs/remotes/origin/forced')).toEqual([`${argv}: storing head`, `${argv}: forced-update`]);
    expect(reflog(t, 'refs/remotes/origin/main').at(-1)).toBe(`${argv}: fast-forward`);
    expect(reflog(t, 'refs/remotes/origin/feature/ünï')).toEqual([`${argv}: storing head`]);
    expect(await t.rev('refs/remotes/origin/feature/ünï')).toBe(elsewhere);
  });

  it('a non-forcing refspec rejects a rewritten branch, still stores the rest, and announces them', async () => {
    const { t, origin, ctx, id } = await setup();
    const base = await t.rev('main');
    await git.writeRef({ fs: t.memfs, gitdir: origin, ref: 'refs/heads/feature/forced', value: base });
    const a = await commitInOrigin(t, origin, 'feature/forced', 'f.txt', 'f\n', 'Forced');
    await remoteHandlers.fetch({ repo: id, background: false, remote: 'origin' }, ctx);
    await git.setConfig({ fs: t.memfs, dir: t.dir, path: 'remote.origin.fetch', value: 'refs/heads/*:refs/remotes/origin/*' });
    await git.writeRef({ fs: t.memfs, gitdir: origin, ref: 'refs/heads/feature/forced', value: base, force: true });
    await git.writeRef({ fs: t.memfs, gitdir: origin, ref: 'refs/heads/fresh', value: base });
    const from = ctx.events.length;
    await expect(remoteHandlers.fetch({ repo: id, background: false, remote: 'origin' }, ctx)).rejects.toMatchObject({ kind: 'NonFastForward', message: "refs/remotes/origin/feature/forced: the remote's feature/forced isn't a fast-forward (rejected)" });
    expect(await t.rev('refs/remotes/origin/feature/forced')).toBe(a);
    expect(await t.rev('refs/remotes/origin/fresh')).toBe(base);
    const seen = ctx.events.slice(from).filter((e) => e.type !== 'queueChanged').map((e) => e.type);
    expect(seen).toEqual(['opStarted', 'refsUpdated', 'opFinished']);
  });

  it('a user fetch holds the queue\'s running slot, not the write lock', async () => {
    const { t, origin, ctx, id } = await setup();
    await commitInOrigin(t, origin, 'main', 'b.txt', 'b\n', 'Remote change');
    netOf(ctx).latencyMs = 50;
    let fetched = false;
    const pending = remoteHandlers.fetch({ repo: id, background: false }, ctx).then(() => (fetched = true));
    await new Promise((r) => setTimeout(r, 5));
    const q = ctx.writes.queue(id, ctx.emit);
    // An immediate write (stage, save) takes the lock at once, mid-transfer.
    const release = await Promise.race([q.lock(), new Promise<null>((r) => setTimeout(() => r(null), 20))]);
    expect(release).not.toBeNull();
    release!();
    expect(fetched).toBe(false);
    // A queued write waits for the fetch to end.
    const ticket = q.enqueue('commit "x"', 'commit', ctx.writes.nextOp());
    let turnedAfterFetch: boolean | null = null;
    const turn = q.turn(ticket).then((s) => ((turnedAfterFetch = ctx.events.some((e) => e.type === 'opFinished')), s));
    await new Promise((r) => setTimeout(r, 10));
    expect(turnedAfterFetch).toBeNull();
    await pending;
    const slot = await turn;
    expect(turnedAfterFetch).toBe(true);
    q.finish(null, []);
    (await slot.lock())();
  });

  it('fetches every remote, each as git\'s child fetch, and names the ones that failed', async () => {
    const { t, origin, ctx, id } = await setup();
    await git.setConfig({ fs: t.memfs, dir: t.dir, path: 'remote.upstream.url', value: 'https://github.com/o/r.git' });
    await git.setConfig({ fs: t.memfs, dir: t.dir, path: 'remote.upstream.fetch', value: '+refs/heads/*:refs/remotes/upstream/*' });
    const theirs = await commitInOrigin(t, origin, 'main', 'b.txt', 'b\n', 'Remote change');
    await expect(remoteHandlers.fetch({ repo: id, background: false }, ctx)).rejects.toMatchObject({
      kind: 'Other',
      message: 'Not in the demo: fetching from github.com',
      detail: { kind: 'fetchFailed', remotes: [{ name: 'upstream', reason: 'not in the demo' }] },
    });
    expect(await t.rev('refs/remotes/origin/main')).toBe(theirs);
    expect(reflog(t, 'refs/remotes/origin/main').at(-1)).toBe('fetch --append --no-auto-gc --no-write-commit-graph --prune --no-prune-tags origin: fast-forward');
    const seen = ctx.events.filter((e) => e.type !== 'queueChanged').map((e) => (e.type === 'opProgress' ? e.phase : e.type));
    expect(seen).toEqual(['opStarted', 'Fetching origin', 'Fetching upstream', 'refsUpdated', 'opFinished']);
    expect(ctx.events.find((e) => e.type === 'opFinished')).toMatchObject({ outcome: 'failed', message: 'Not in the demo: fetching from github.com' });
  });

  it('a fetch of an unreachable remote changes nothing and says why', async () => {
    const { t, ctx, id } = await setup();
    await git.setConfig({ fs: t.memfs, dir: t.dir, path: 'remote.upstream.url', value: 'https://github.com/o/r.git' });
    const before = await t.rev('refs/remotes/origin/main');
    await expect(remoteHandlers.fetch({ repo: id, background: false, remote: 'upstream' }, ctx)).rejects.toMatchObject({ message: 'Not in the demo: fetching from github.com' });
    expect(await t.rev('refs/remotes/origin/main')).toBe(before);
    await expect(remoteHandlers.fetch({ repo: id, background: false, remote: 'nope' }, ctx)).rejects.toMatchObject({ kind: 'NotFound', message: 'No remote nope' });
  });

  it('fetches a merge request\'s head alone, into its Compare ref, dropping the previous one', async () => {
    const { t, origin, ctx, id } = await setup();
    const head = await commitInOrigin(t, origin, 'main', 'm.txt', 'm\n', 'MR head');
    const base = await t.rev('main');
    await git.writeRef({ fs: t.memfs, gitdir: origin, ref: 'refs/merge-requests/4/head', value: head });
    await git.writeRef({ fs: t.memfs, gitdir: origin, ref: 'refs/heads/main', value: base, force: true });
    await commitInOrigin(t, origin, 'main', 'n.txt', 'n\n', 'Elsewhere');
    await git.writeRef({ fs: t.memfs, dir: t.dir, ref: 'refs/remotes/origin/gone', value: base });
    await git.writeRef({ fs: t.memfs, dir: t.dir, ref: `${COMPARE_REFS}origin/mr/2`, value: base });
    await git.writeRef({ fs: t.memfs, dir: t.dir, ref: 'refs/gitbolt/compare/origin/mr/1', value: base });
    await expect(remoteHandlers.fetch({ repo: id, background: false, mrHead: { kind: 'gitlab', number: 4 } }, ctx)).rejects.toMatchObject({ kind: 'InvalidInput' });
    const r = await remoteHandlers.fetch({ repo: id, background: false, remote: 'origin', mrHead: { kind: 'gitlab', number: 4 } }, ctx);
    expect(r).toMatchObject({ status: 'done', changed: true });
    expect(await t.rev(`${COMPARE_REFS}origin/mr/4`)).toBe(head);
    await expect(t.rev(`${COMPARE_REFS}origin/mr/2`)).rejects.toBeTruthy();
    await expect(t.rev('refs/gitbolt/compare/origin/mr/1')).rejects.toBeTruthy();
    // A command-line refspec fetches that ref only: the tracking refs neither move nor get pruned.
    expect(await t.rev('refs/remotes/origin/main')).toBe(base);
    expect(await t.rev('refs/remotes/origin/gone')).toBe(base);
    expect(ctx.events.find((e) => e.type === 'opFinished')).toMatchObject({ command: `git fetch --prune --no-prune-tags --progress --end-of-options origin +refs/merge-requests/4/head:${COMPARE_REFS}origin/mr/4` });
    await expect(remoteHandlers.fetch({ repo: id, background: false, remote: 'origin', mrHead: { kind: 'gitlab', number: 77 } }, ctx)).rejects.toMatchObject({ kind: 'Other', message: "couldn't find remote ref refs/merge-requests/77/head" });
  });

  it('a Cancel during the transfer cancels it', async () => {
    const { t, origin, ctx, id } = await setup();
    await commitInOrigin(t, origin, 'main', 'b.txt', 'b\n', 'Remote change');
    netOf(ctx).latencyMs = 50;
    const pending = remoteHandlers.fetch({ repo: id, background: false }, ctx);
    await new Promise((r) => setTimeout(r, 5));
    const started = ctx.events.find((e) => e.type === 'opStarted' && e.kind === 'fetch') as { op: number };
    await HANDLERS.cancelOp({ op: started.op }, ctx);
    await expect(pending).rejects.toMatchObject({ kind: 'Cancelled' });
    expect(await t.rev('refs/remotes/origin/main')).toBe(await t.rev('main'));
    expect(ctx.events.find((e) => e.type === 'opFinished')).toMatchObject({ outcome: 'cancelled', message: 'Cancelled' });
    expect(ctx.events.some((e) => e.type === 'refsUpdated')).toBe(false);
  });

  it('a background fetch runs only while the queue is idle, and a queued write cancels it quietly', async () => {
    const { t, origin, ctx, id } = await setup();
    await commitInOrigin(t, origin, 'main', 'b.txt', 'b\n', 'Remote change');
    netOf(ctx).latencyMs = 50;
    const pending = remoteHandlers.fetch({ repo: id, background: true }, ctx);
    await new Promise((r) => setTimeout(r, 5));
    expect(ctx.events.find((e) => e.type === 'opStarted')).toMatchObject({ kind: 'fetch', interactive: false });
    expect(await remoteHandlers.fetch({ repo: id, background: true }, ctx)).toEqual({ status: 'skipped', reason: 'busy' });
    const user = remoteHandlers.fetch({ repo: id, background: false }, ctx);
    expect(await pending).toEqual({ status: 'skipped', reason: 'busy' });
    expect(ctx.events.find((e) => e.type === 'opFinished')).toMatchObject({ outcome: 'skipped', message: null, command: 'git fetch --prune --no-prune-tags --no-write-fetch-head --progress --all' });
    expect(await user).toMatchObject({ status: 'done', changed: true });
  });
});
