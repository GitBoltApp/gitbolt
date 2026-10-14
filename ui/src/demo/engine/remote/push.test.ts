import * as git from 'isomorphic-git';
import { describe, expect, it } from 'vitest';
import type { MemFs } from '../memfs';
import { makeTestRepo } from '../read/testkit';
import { leaseFor, recordRewrite, rewrittenOf } from '../seq/rewrites';
import { openForWrite } from '../writeSeamTest';
import { NO_EXPECT } from '../writeSeam';
import { HANDLERS } from '../../handlers';
import { remoteHandlers } from '../../handlers/remotes';
import { netOf } from './network';
import { commitInOrigin, withOrigin } from './testkit';

const YOU = { name: 'You', email: 'you@example.com' };

async function setup() {
  const t = await makeTestRepo();
  await t.write('a.txt', 'a\n');
  await t.commit('Base');
  const origin = await withOrigin(t, ['main']);
  const w = await openForWrite(t);
  netOf(w.ctx).latencyMs = 0;
  w.ctx.state.settings.pushFollowTags = true;
  return { t, origin, ...w };
}
const originRef = (t: { memfs: MemFs }, origin: string, ref: string) => git.resolveRef({ fs: t.memfs, gitdir: origin, ref });
const reflog = (t: Awaited<ReturnType<typeof makeTestRepo>>, ref: string) =>
  (t.memfs.readFileSync(`${t.repo.gitdir}/logs/${ref}`, 'utf8') as string).trimEnd().split('\n').map((l) => l.split('\t')[1]);

describe('push', () => {
  it('pushes a branch to its upstream, moves the tracking ref, and sends its annotated tags', async () => {
    const { t, origin, ctx, id, wt } = await setup();
    const base = await t.rev('main');
    await t.write('b.txt', 'b\n');
    const mine = await t.commit('Mine');
    await git.annotatedTag({ fs: t.memfs, dir: t.dir, ref: 'v1', object: mine, message: 'v1', tagger: { name: 'You', email: 'you@example.com', timestamp: 1_767_225_600, timezoneOffset: 0 } });
    await git.tag({ fs: t.memfs, dir: t.dir, ref: 'light', object: mine });
    const r = await remoteHandlers.push({ repo: id, worktree: wt, branch: 'main', expect: NO_EXPECT }, ctx);
    expect(r.outcome).toMatchObject({ branch: 'main', remote: 'origin', dst: 'main', upToDate: false, server: { lines: 0, warning: null }, forced: null });
    expect(await originRef(t, origin, 'refs/heads/main')).toBe(mine);
    expect(await t.rev('refs/remotes/origin/main')).toBe(mine);
    expect(await originRef(t, origin, 'refs/tags/v1')).toBeTruthy();
    // A lightweight tag isn't followed (git's --follow-tags).
    await expect(originRef(t, origin, 'refs/tags/light')).rejects.toBeTruthy();
    // git's reflog line for the tracking ref; the journal's Barrier; the refs announced.
    expect(reflog(t, 'refs/remotes/origin/main').at(-1)).toBe('update by push');
    expect([r.journal.undo?.label, r.journal.undoBlocked]).toEqual(['push main to origin/main', "Push can't be undone"]);
    expect(ctx.events.some((e) => e.type === 'refsUpdated')).toBe(true);
    expect(ctx.events.some((e) => e.type === 'opRemote')).toBe(false);
    expect((await remoteHandlers.push({ repo: id, worktree: wt, branch: 'main', expect: NO_EXPECT }, ctx)).outcome.upToDate).toBe(true);
    // A new annotated tag on an older commit is still sent: not up to date (checked on the binary).
    await git.annotatedTag({ fs: t.memfs, dir: t.dir, ref: 'v0', object: base, message: 'v0', tagger: { name: 'You', email: 'you@example.com', timestamp: 1_767_225_600, timezoneOffset: 0 } });
    expect((await remoteHandlers.push({ repo: id, worktree: wt, branch: 'main', expect: NO_EXPECT }, ctx)).outcome.upToDate).toBe(false);
    expect(await originRef(t, origin, 'refs/tags/v0')).toBeTruthy();
  });

  it('a push behind the teammate is refused in the core\'s words', async () => {
    const { t, origin, ctx, id, wt } = await setup();
    const theirs = await commitInOrigin(t, origin, 'main', 'r.txt', 'r\n', 'Remote change');
    await t.write('b.txt', 'b\n');
    await t.commit('Mine');
    await expect(remoteHandlers.push({ repo: id, worktree: wt, branch: 'main', expect: NO_EXPECT }, ctx)).rejects.toMatchObject({ kind: 'NonFastForward', message: "origin/main has commits main doesn't have" });
    expect(await originRef(t, origin, 'refs/heads/main')).toBe(theirs);
    expect(await t.rev('refs/remotes/origin/main')).not.toBe(theirs);
  });

  it('sets an upstream for a new branch, and a non-ASCII branch round-trips', async () => {
    const { t, origin, ctx, id, wt } = await setup();
    await t.branch('feature/ünï');
    await t.checkout('feature/ünï');
    await t.write('u.txt', 'u\n');
    const tip = await t.commit('Unicode');
    await expect(remoteHandlers.push({ repo: id, worktree: wt, branch: 'feature/ünï', expect: NO_EXPECT }, ctx)).rejects.toMatchObject({ message: 'feature/ünï has no upstream; set one from Push ▾' });
    const r = await remoteHandlers.push({ repo: id, worktree: wt, branch: 'feature/ünï', target: { remote: 'origin', branch: 'feature/ünï' }, setUpstream: true, expect: NO_EXPECT }, ctx);
    expect(r.outcome).toMatchObject({ branch: 'feature/ünï', remote: 'origin', dst: 'feature/ünï', upToDate: false });
    expect(await originRef(t, origin, 'refs/heads/feature/ünï')).toBe(tip);
    expect(await t.rev('refs/remotes/origin/feature/ünï')).toBe(tip);
    expect(reflog(t, 'refs/remotes/origin/feature/ünï')).toEqual(['update by push']);
    expect(await git.getConfig({ fs: t.memfs, dir: t.dir, path: 'branch.feature/ünï.remote' })).toBe('origin');
    expect(await git.getConfig({ fs: t.memfs, dir: t.dir, path: 'branch.feature/ünï.merge' })).toBe('refs/heads/feature/ünï');
  });

  it('an up-to-date push still moves a stale tracking ref, as git does', async () => {
    const { t, ctx, id, wt } = await setup();
    const base = await t.rev('main');
    await t.write('b.txt', 'b\n');
    const mine = await t.commit('Mine');
    await remoteHandlers.push({ repo: id, worktree: wt, branch: 'main', expect: NO_EXPECT }, ctx);
    await git.writeRef({ fs: t.memfs, dir: t.dir, ref: 'refs/remotes/origin/main', value: base, force: true });
    const r = await remoteHandlers.push({ repo: id, worktree: wt, branch: 'main', expect: NO_EXPECT }, ctx);
    expect(r.outcome.upToDate).toBe(true);
    expect(await t.rev('refs/remotes/origin/main')).toBe(mine);
  });

  it('a forced push with a stale lease is refused; a current one forces', async () => {
    const { t, origin, ctx, id, wt } = await setup();
    const seen = await t.rev('refs/remotes/origin/main');
    const theirs = await commitInOrigin(t, origin, 'main', 'r.txt', 'r\n', 'Remote change');
    await expect(remoteHandlers.push({ repo: id, worktree: wt, branch: 'main', lease: { oid: seen }, expect: NO_EXPECT }, ctx)).rejects.toMatchObject({ kind: 'RefMoved' });
    // `null`: the branch must not exist there.
    await expect(remoteHandlers.push({ repo: id, worktree: wt, branch: 'main', lease: { oid: null }, expect: NO_EXPECT }, ctx)).rejects.toMatchObject({ kind: 'RefMoved' });
    expect(await originRef(t, origin, 'refs/heads/main')).toBe(theirs);
    await t.write('b.txt', 'b\n');
    const mine = await t.commit('Mine');
    const r = await remoteHandlers.push({ repo: id, worktree: wt, branch: 'main', lease: { oid: theirs }, expect: NO_EXPECT }, ctx);
    expect([r.outcome.upToDate, r.outcome.forced]).toEqual([false, null]);
    expect(await originRef(t, origin, 'refs/heads/main')).toBe(mine);
  });

  it('a rewritten pushed branch forces with its mark\'s lease, without asking, once', async () => {
    const { t, origin, ctx, id, wt } = await setup();
    await t.branch('dev');
    await t.checkout('dev');
    await t.write('d.txt', 'dev\n');
    const old = await t.commit('Dev work', YOU);
    await remoteHandlers.push({ repo: id, worktree: wt, branch: 'dev', target: { remote: 'origin', branch: 'dev' }, setUpstream: true, expect: NO_EXPECT }, ctx);
    await t.write('d.txt', 'dev, amended\n');
    const rewritten = await t.commit('Dev work, amended', YOU, { parents: [await t.rev('main')] });
    await git.writeRef({ fs: t.memfs, dir: t.dir, ref: 'refs/heads/dev', value: rewritten, force: true });
    await recordRewrite(t.repo, 'amend', [{ name: 'refs/heads/dev', old, new: rewritten }], YOU.email);
    expect(await rewrittenOf(t.repo, 'dev')).toEqual({ kind: 'amend', remote: 'origin' });
    const r = await remoteHandlers.push({ repo: id, worktree: wt, branch: 'dev', expect: NO_EXPECT }, ctx);
    expect(r.outcome).toMatchObject({ upToDate: false, forced: 'amend' });
    expect(await originRef(t, origin, 'refs/heads/dev')).toBe(rewritten);
    expect(await leaseFor(t.repo, 'dev', { remote: 'origin', branch: 'dev' })).toBeNull();
  });

  it('a rewrite mark whose lease went stale is today\'s rejected push', async () => {
    const { t, origin, ctx, id, wt } = await setup();
    await t.branch('dev');
    await t.checkout('dev');
    await t.write('d.txt', 'dev\n');
    const old = await t.commit('Dev work', YOU);
    await remoteHandlers.push({ repo: id, worktree: wt, branch: 'dev', target: { remote: 'origin', branch: 'dev' }, setUpstream: true, expect: NO_EXPECT }, ctx);
    await commitInOrigin(t, origin, 'dev', 'r.txt', 'r\n', 'Teammate on dev');
    await t.write('d.txt', 'dev, amended\n');
    const rewritten = await t.commit('Dev work, amended', YOU, { parents: [await t.rev('main')] });
    await git.writeRef({ fs: t.memfs, dir: t.dir, ref: 'refs/heads/dev', value: rewritten, force: true });
    await recordRewrite(t.repo, 'amend', [{ name: 'refs/heads/dev', old, new: rewritten }], YOU.email);
    await expect(remoteHandlers.push({ repo: id, worktree: wt, branch: 'dev', expect: NO_EXPECT }, ctx)).rejects.toMatchObject({ kind: 'NonFastForward', message: "origin/dev has commits dev doesn't have" });
  });

  it('shows the server\'s lines: GitLab\'s link for a new branch, counted only past its boilerplate', async () => {
    const { t, ctx, id, wt } = await setup();
    const calls: [string, boolean][] = [];
    netOf(ctx).serverLines.push(async (_fs, _gitdir, branch, created) => {
      calls.push([branch, created]);
      return created
        ? ['', `To create a merge request for ${branch}, visit:`, `  https://gitlab.example.com/orbital/orbital/-/merge_requests/new?merge_request%5Bsource_branch%5D=${encodeURIComponent(branch)}`, '']
        : ['Deployed preview', 'integration: rebase failed: conflict in a.txt'];
    });
    await t.branch('feature/ünï');
    const target = { remote: 'origin', branch: 'feature/ünï' };
    const first = await remoteHandlers.push({ repo: id, worktree: wt, branch: 'feature/ünï', target, setUpstream: true, expect: NO_EXPECT }, ctx);
    expect(first.outcome.server).toEqual({ lines: 0, warning: null });
    const remote = ctx.events.find((e) => e.type === 'opRemote') as { op: number; lines: { text: string; kind: string }[] };
    expect(remote.op).toBe(first.outcome.op);
    expect(remote.lines[2]).toEqual({ text: '  https://gitlab.example.com/orbital/orbital/-/merge_requests/new?merge_request%5Bsource_branch%5D=feature%2F%C3%BCn%C3%AF', kind: 'boilerplate' });
    await t.checkout('feature/ünï');
    await t.write('b.txt', 'b\n');
    await t.commit('More');
    const second = await remoteHandlers.push({ repo: id, worktree: wt, branch: 'feature/ünï', expect: NO_EXPECT }, ctx);
    expect(second.outcome.server).toEqual({ lines: 2, warning: 'integration: rebase failed: conflict in a.txt' });
    await remoteHandlers.push({ repo: id, worktree: wt, branch: 'feature/ünï', expect: NO_EXPECT }, ctx);
    expect(calls).toEqual([['feature/ünï', true], ['feature/ünï', false]]);
  });

  it('the transfer runs without the write lock, and a Cancel during it writes nothing', async () => {
    const { t, origin, ctx, id, wt } = await setup();
    const base = await t.rev('main');
    await t.write('b.txt', 'b\n');
    await t.commit('Mine');
    netOf(ctx).latencyMs = 50;
    const pending = remoteHandlers.push({ repo: id, worktree: wt, branch: 'main', expect: NO_EXPECT }, ctx);
    await new Promise((r) => setTimeout(r, 10));
    // An immediate write (stage, save) takes the lock mid-transfer.
    const release = await Promise.race([ctx.writes.queue(id, ctx.emit).lock(), new Promise<null>((r) => setTimeout(() => r(null), 20))]);
    expect(release).not.toBeNull();
    expect(await originRef(t, origin, 'refs/heads/main')).toBe(base);
    release!();
    await pending;
    // Cancelled while it transfers: the origin is as it was.
    await t.write('c.txt', 'c\n');
    await t.commit('More');
    const tip = await originRef(t, origin, 'refs/heads/main');
    const cancelled = remoteHandlers.push({ repo: id, worktree: wt, branch: 'main', expect: NO_EXPECT }, ctx);
    await new Promise((r) => setTimeout(r, 10));
    const started = ctx.events.filter((e) => e.type === 'opStarted' && e.kind === 'push').at(-1) as { op: number };
    await HANDLERS.cancelOp({ op: started.op }, ctx);
    await expect(cancelled).rejects.toMatchObject({ kind: 'Cancelled' });
    expect(await originRef(t, origin, 'refs/heads/main')).toBe(tip);
    expect(ctx.events.filter((e) => e.type === 'opFinished').at(-1)).toMatchObject({ kind: 'push', outcome: 'cancelled' });
  });

  it('pushes one tag, every tag, and refuses a different tag of the same name', async () => {
    const { t, origin, ctx, id, wt } = await setup();
    await git.tag({ fs: t.memfs, dir: t.dir, ref: 'v2', object: await t.rev('main') });
    const r = await remoteHandlers.pushTags({ repo: id, worktree: wt, remote: 'origin', tag: 'v2' }, ctx);
    expect(r.outcome).toMatchObject({ remote: 'origin', tag: 'v2', upToDate: false, server: { lines: 0, warning: null } });
    expect(r.journal.undo?.label).toBe('push tag v2 to origin');
    expect((await remoteHandlers.pushTags({ repo: id, worktree: wt, remote: 'origin', tag: 'v2' }, ctx)).outcome.upToDate).toBe(true);
    await git.writeRef({ fs: t.memfs, gitdir: origin, ref: 'refs/tags/v3', value: await t.rev('main') });
    await t.write('z.txt', 'z\n');
    await git.tag({ fs: t.memfs, dir: t.dir, ref: 'v3', object: await t.commit('Z') });
    await expect(remoteHandlers.pushTags({ repo: id, worktree: wt, remote: 'origin', tag: 'v3' }, ctx)).rejects.toMatchObject({ kind: 'NonFastForward', message: 'origin already has a different tag v3' });
    await expect(remoteHandlers.pushTags({ repo: id, worktree: wt, remote: 'origin', tag: 'v4' }, ctx)).rejects.toMatchObject({ kind: 'NotFound', message: 'No tag v4' });
    // `--tags`: the others still go, then the clash is refused (checked on the binary).
    await git.tag({ fs: t.memfs, dir: t.dir, ref: 'v5', object: await t.rev('main') });
    await expect(remoteHandlers.pushTags({ repo: id, worktree: wt, remote: 'origin' }, ctx)).rejects.toMatchObject({ kind: 'NonFastForward', message: 'origin already has different tags with some of these names' });
    expect(await originRef(t, origin, 'refs/tags/v5')).toBe(await t.rev('main'));
    await expect(remoteHandlers.pushTags({ repo: id, worktree: wt, remote: 'nowhere', tag: 'v2' }, ctx)).rejects.toMatchObject({ kind: 'NotFound', message: "'nowhere' does not appear to be a git repository" });
  });

  it('a remote the demo can\'t reach fails at once and changes nothing', async () => {
    const { t, ctx, id, wt } = await setup();
    await git.setConfig({ fs: t.memfs, dir: t.dir, path: 'remote.origin.url', value: 'https://ada:secret@github.com/orbital/orbital.git' });
    await t.write('b.txt', 'b\n');
    await t.commit('Mine');
    const before = await t.rev('refs/remotes/origin/main');
    const err = await remoteHandlers.push({ repo: id, worktree: wt, branch: 'main', expect: NO_EXPECT }, ctx).catch((e: unknown) => e);
    expect(err).toMatchObject({ kind: 'Other', message: 'Not in the demo: pushing to github.com' });
    expect(await t.rev('refs/remotes/origin/main')).toBe(before);
  });
});

describe('remote deletes', () => {
  it('deletes a branch on the origin and here, the push a Barrier below the local delete', async () => {
    const { t, origin, ctx, id, wt } = await setup();
    await t.branch('gone');
    await remoteHandlers.push({ repo: id, worktree: wt, branch: 'gone', target: { remote: 'origin', branch: 'gone' }, setUpstream: true, expect: NO_EXPECT }, ctx);
    const lease = await t.rev('refs/remotes/origin/gone');
    const r = await HANDLERS.deleteBranch({ repo: id, worktree: wt, branch: 'gone', local: true, remote: { remote: 'origin', branch: 'gone', lease }, force: false, expect: NO_EXPECT }, ctx);
    expect(r.outcome).toEqual({ status: 'deleted' });
    await expect(originRef(t, origin, 'refs/heads/gone')).rejects.toBeTruthy();
    await expect(t.rev('refs/remotes/origin/gone')).rejects.toBeTruthy();
    await expect(t.rev('refs/heads/gone')).rejects.toBeTruthy();
    expect(t.memfs.existsSync(`${t.repo.gitdir}/logs/refs/remotes/origin/gone`)).toBe(false);
    const undo = ctx.writes.journal(t.dir).undo;
    expect(undo.slice(-2).map((e) => [e.label, e.undo, e.note])).toEqual([
      ['delete origin/gone', 'barrier', null],
      ['delete branch gone and origin/gone', 'moveRefs', 'origin/gone stays deleted'],
    ]);
    // Undo brings back the local branch only.
    expect(undo.at(-1)!.refs.map((m) => m.name)).toEqual(['refs/heads/gone']);
  });

  it('a remote-only delete is a Barrier; a stale lease says to fetch, a moved tracking ref is refused first', async () => {
    const { t, origin, ctx, id, wt } = await setup();
    await t.branch('topic');
    await remoteHandlers.push({ repo: id, worktree: wt, branch: 'topic', target: { remote: 'origin', branch: 'topic' }, setUpstream: true, expect: NO_EXPECT }, ctx);
    const lease = await t.rev('refs/remotes/origin/topic');
    const del = (l: string) => HANDLERS.deleteBranch({ repo: id, worktree: wt, branch: 'topic', local: false, remote: { remote: 'origin', branch: 'topic', lease: l }, force: false, expect: NO_EXPECT }, ctx);
    await expect(del('0'.repeat(40))).rejects.toMatchObject({ kind: 'RefMoved', message: 'origin/topic changed outside GitVolt' });
    const theirs = await commitInOrigin(t, origin, 'topic', 'r.txt', 'r\n', 'Teammate');
    await expect(del(lease)).rejects.toMatchObject({ kind: 'RefMoved', message: 'origin/topic changed on the server. Fetch, then try again.' });
    expect(await originRef(t, origin, 'refs/heads/topic')).toBe(theirs);
    await git.writeRef({ fs: t.memfs, dir: t.dir, ref: 'refs/remotes/origin/topic', value: theirs, force: true });
    const r = await del(theirs);
    expect([r.journal.undo?.label, r.journal.undoBlocked]).toEqual(['delete origin/topic', "Push can't be undone"]);
    await expect(originRef(t, origin, 'refs/heads/topic')).rejects.toBeTruthy();
    expect(await t.rev('refs/heads/topic')).toBe(lease);
  });

  it('deletes a tag on the origin and here; a tag the origin lacks is NotFound and the local one stays', async () => {
    const { t, origin, ctx, id, wt } = await setup();
    await git.tag({ fs: t.memfs, dir: t.dir, ref: 'v1', object: await t.rev('main') });
    await remoteHandlers.pushTags({ repo: id, worktree: wt, remote: 'origin', tag: 'v1' }, ctx);
    const r = await HANDLERS.deleteTag({ repo: id, worktree: wt, name: 'v1', local: true, remote: 'origin' }, ctx);
    expect(r.journal.undo?.label).toBe('delete tag v1 here and from origin');
    await expect(originRef(t, origin, 'refs/tags/v1')).rejects.toBeTruthy();
    await expect(t.rev('refs/tags/v1')).rejects.toBeTruthy();
    expect(ctx.writes.journal(t.dir).undo.slice(-2).map((e) => [e.label, e.undo])).toEqual([
      ['delete tag v1 from origin', 'barrier'],
      ['delete tag v1 here and from origin', 'moveRefs'],
    ]);
    await git.tag({ fs: t.memfs, dir: t.dir, ref: 'v2', object: await t.rev('main') });
    await expect(HANDLERS.deleteTag({ repo: id, worktree: wt, name: 'v2', local: true, remote: 'origin' }, ctx)).rejects.toMatchObject({ kind: 'NotFound', message: 'origin has no tag v2' });
    expect(await t.rev('refs/tags/v2')).toBeTruthy();
    expect(ctx.events.filter((e) => e.type === 'opRemote').at(-1)).toMatchObject({ lines: [{ text: 'warning: deleting a non-existent ref', kind: 'warning' }] });
    await expect(HANDLERS.deleteTag({ repo: id, worktree: wt, name: 'v2', local: false }, ctx)).rejects.toMatchObject({ kind: 'InvalidInput', message: 'Nothing to delete' });
  });
});
