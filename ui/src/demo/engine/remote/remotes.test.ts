import * as git from 'isomorphic-git';
import { describe, expect, it } from 'vitest';
import { makeTestRepo } from '../read/testkit';
import { openForWrite } from '../writeSeamTest';
import { remoteHandlers } from '../../handlers/remotes';
import { undoHandlers } from '../../handlers/undo';
import { buildSidebar } from '../sidebar';
import { withOrigin } from './testkit';

const cfg = (t: Awaited<ReturnType<typeof makeTestRepo>>, path: string) => git.getConfigAll({ fs: t.memfs, dir: t.dir, path });

describe('remotes', () => {
  it('adds one, refusing a bad name, a bad URL and a taken name', async () => {
    const t = await makeTestRepo();
    await t.commit('Base');
    await withOrigin(t, ['main']);
    const { ctx, id, wt } = await openForWrite(t);
    await remoteHandlers.addRemote({ repo: id, worktree: wt, name: 'alice', url: 'https://gitlab.example.com/alice/orbital.git' }, ctx);
    expect(await git.getConfig({ fs: t.memfs, dir: t.dir, path: 'remote.alice.fetch' })).toBe('+refs/heads/*:refs/remotes/alice/*');
    await expect(remoteHandlers.addRemote({ repo: id, worktree: wt, name: 'alice', url: 'x' }, ctx)).rejects.toMatchObject({ kind: 'InvalidInput', message: 'A remote named alice already exists' });
    await expect(remoteHandlers.addRemote({ repo: id, worktree: wt, name: 'bob', url: '-x' }, ctx)).rejects.toMatchObject({ message: "A remote URL can't start with -" });
    await expect(remoteHandlers.addRemote({ repo: id, worktree: wt, name: 'bob', url: '' }, ctx)).rejects.toMatchObject({ message: "Enter the remote's URL" });
    await expect(remoteHandlers.addRemote({ repo: id, worktree: wt, name: 'b ob', url: 'x' }, ctx)).rejects.toMatchObject({ kind: 'InvalidInput' });
  });

  it('removes one with its tracking refs and the upstreams that named it', async () => {
    const t = await makeTestRepo();
    await t.commit('Base');
    await withOrigin(t, ['main']);
    const { ctx, id, wt } = await openForWrite(t);
    await remoteHandlers.removeRemote({ repo: id, worktree: wt, name: 'origin' }, ctx);
    expect(await git.listRemotes({ fs: t.memfs, dir: t.dir })).toEqual([]);
    await expect(t.rev('refs/remotes/origin/main')).rejects.toBeTruthy();
    expect(await git.getConfig({ fs: t.memfs, dir: t.dir, path: 'branch.main.remote' })).toBeUndefined();
    expect(await git.getConfig({ fs: t.memfs, dir: t.dir, path: 'branch.main.merge' })).toBeUndefined();
    await expect(remoteHandlers.removeRemote({ repo: id, worktree: wt, name: 'origin' }, ctx)).rejects.toMatchObject({ kind: 'NotFound', message: 'No remote origin' });
  });

  it('Undo and Redo of a removal restore the config exactly, a multi-valued key too', async () => {
    const t = await makeTestRepo();
    const base = await t.commit('Base');
    await withOrigin(t, ['main']);
    await git.setConfig({ fs: t.memfs, dir: t.dir, path: 'remote.origin.fetch', value: '+refs/pull/*/head:refs/remotes/origin/pr/*', append: true });
    const { ctx, id, wt } = await openForWrite(t);
    const fetchBefore = await cfg(t, 'remote.origin.fetch');
    expect(fetchBefore).toHaveLength(2);
    await remoteHandlers.removeRemote({ repo: id, worktree: wt, name: 'origin' }, ctx);
    const top = () => ctx.writes.journal(wt).undoTop()!.id;
    await undoHandlers.undo({ repo: id, worktree: wt, entry: top() }, ctx);
    expect(await cfg(t, 'remote.origin.fetch')).toEqual(fetchBefore);
    expect(await cfg(t, 'remote.origin.url')).toHaveLength(1);
    expect(await cfg(t, 'branch.main.remote')).toEqual(['origin']);
    expect(await cfg(t, 'branch.main.merge')).toEqual(['refs/heads/main']);
    expect(await t.rev('refs/remotes/origin/main')).toBe(base);
    await undoHandlers.redo({ repo: id, worktree: wt, entry: ctx.writes.journal(wt).redoTop()!.id }, ctx);
    expect(await git.listRemotes({ fs: t.memfs, dir: t.dir })).toEqual([]);
    expect(await cfg(t, 'branch.main.remote')).toEqual([]);
    await expect(t.rev('refs/remotes/origin/main')).rejects.toBeTruthy();
  });

  it('removes a symbolic origin/HEAD with the rest', async () => {
    const t = await makeTestRepo();
    await t.commit('Base');
    await withOrigin(t, ['main']);
    await git.writeRef({ fs: t.memfs, dir: t.dir, ref: 'refs/remotes/origin/HEAD', value: 'refs/remotes/origin/main', symbolic: true, force: true });
    t.memfs.mkdirpSync(`${t.repo.gitdir}/logs/refs/remotes/origin`);
    t.memfs.writeFileSync(`${t.repo.gitdir}/logs/refs/remotes/origin/HEAD`, 'x\n');
    const { ctx, id, wt } = await openForWrite(t);
    await remoteHandlers.removeRemote({ repo: id, worktree: wt, name: 'origin' }, ctx);
    await expect(t.rev('refs/remotes/origin/HEAD')).rejects.toBeTruthy();
    expect(t.memfs.existsSync(`${t.repo.gitdir}/logs/refs/remotes/origin/HEAD`, false)).toBe(false);
    await expect(t.rev('refs/remotes/origin/main')).rejects.toBeTruthy();
    const top = () => ctx.writes.journal(wt).undoTop()!.id;
    const heads = async () => (await buildSidebar(ctx.repos.get(id))).remotes.find((g) => g.name === 'origin')?.defaultBranch;
    await undoHandlers.undo({ repo: id, worktree: wt, entry: top() }, ctx);
    expect(await heads()).toBe('refs/remotes/origin/main');
    await undoHandlers.redo({ repo: id, worktree: wt, entry: ctx.writes.journal(wt).redoTop()!.id }, ctx);
    await expect(t.rev('refs/remotes/origin/HEAD')).rejects.toBeTruthy();
  });

  it('refuses an Undo while the name is taken again, and a Redo once it is gone', async () => {
    const t = await makeTestRepo();
    await t.commit('Base');
    await withOrigin(t, ['main']);
    const { ctx, id, wt } = await openForWrite(t);
    await remoteHandlers.removeRemote({ repo: id, worktree: wt, name: 'origin' }, ctx);
    await remoteHandlers.addRemote({ repo: id, worktree: wt, name: 'origin', url: 'https://gitlab.example.com/a/b.git' }, ctx);
    const entry = ctx.writes.journal(wt).undoTop()!.id;
    // Add isn't journaled, so the removal is still the top entry.
    await expect(undoHandlers.undo({ repo: id, worktree: wt, entry }, ctx)).rejects.toMatchObject({ message: 'A remote named origin exists again; remove it to undo' });
  });
});
