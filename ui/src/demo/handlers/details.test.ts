import * as git from 'isomorphic-git';
import { describe, expect, it } from 'vitest';
import { detailsHandlers } from './details';
import { GRACE, fakeCtx, makeTestRepo } from '../engine/read/testkit';

const MESSAGE = 'Rename guide and update assets\n\nRefs !42.\n\nCo-authored-by: Maren Holt <maren@example.com>\nco-authored-by: Lars Tidemann <lars@example.com>';

async function repo() {
  const t = await makeTestRepo();
  await t.write('a.txt', 'a\n');
  const root = await t.commit('Initial commit');
  await t.write('a.txt', 'b\n');
  const second = await t.commit(MESSAGE, GRACE);
  const io = { fs: t.memfs, dir: t.dir };
  await git.addRemote({ ...io, remote: 'upstream', url: 'git@github.com:owner/repo.git' });
  await git.addRemote({ ...io, remote: 'origin', url: 'https://gitlab.example.com/group/project.git' });
  await git.addRemote({ ...io, remote: 'local', url: '/demo/.origins/x.git' });
  await git.writeRef({ ...io, ref: 'refs/remotes/origin/main', value: root });
  return { t, root, second, ctx: fakeCtx(t.repo) };
}

describe('details handlers', () => {
  it('gives a commit\'s header and its message', async () => {
    const { root, second, ctx } = await repo();
    const d = await detailsHandlers.commitDetails({ repo: 1, id: second.toUpperCase() }, ctx);
    expect(d).toMatchObject({ id: second, parents: [root], signed: false, author: { name: 'Grace Hopper', email: 'grace@example.com' } });
    expect(d.coAuthors).toEqual([{ name: 'Maren Holt', email: 'maren@example.com' }, { name: 'Lars Tidemann', email: 'lars@example.com' }]);
    const m = await detailsHandlers.commitMessage({ repo: 1, id: second }, ctx);
    expect(m.summary).toBe('Rename guide and update assets');
    expect(m.body.startsWith('Refs !42.')).toBe(true);
    await expect(detailsHandlers.commitDetails({ repo: 1, id: 'abc' }, ctx)).rejects.toMatchObject({ kind: 'InvalidInput' });
    expect(await detailsHandlers.signature({ repo: 1, id: second }, ctx)).toEqual({ kind: 'unsigned', signer: '', key: '', fingerprint: '', trust: '', detail: null });
  });

  it('lists remotes origin first, with what their URLs say', async () => {
    const { ctx } = await repo();
    expect(await detailsHandlers.remotes({ repo: 1 }, ctx)).toEqual([
      { name: 'origin', host: 'gitlab.example.com', path: 'group/project', hostKind: 'gitlab' },
      { name: 'local', host: null, path: null, hostKind: 'generic' },
      { name: 'upstream', host: 'github.com', path: 'owner/repo', hostKind: 'github' },
    ]);
  });

  it('finds merge bases from ids or full ref names only', async () => {
    const { root, second, ctx } = await repo();
    const ask = (a: string, b: string) => detailsHandlers.mergeBase({ repo: 1, a, b }, ctx);
    expect(await ask(second, root)).toBe(root);
    expect(await ask(second, '0'.repeat(40))).toBeNull();
    await expect(ask('zz', root)).rejects.toMatchObject({ kind: 'InvalidInput', message: "zz isn't a commit id" });
    await expect(ask('HEAD', root)).rejects.toMatchObject({ kind: 'InvalidInput' });
    expect(await ask('refs/heads/main', root)).toBe(root);
    await expect(ask('refs/heads/nope', root)).rejects.toMatchObject({ kind: 'NotFound', message: "refs/heads/nope doesn't exist" });
  });

  it('says when a remote ref was last pushed or fetched, from its reflog', async () => {
    const { t, root, ctx } = await repo();
    await expect(detailsHandlers.lastPush({ repo: 1, remoteRef: 'refs/heads/main' }, ctx)).rejects.toMatchObject({ kind: 'InvalidInput', message: 'not a remote-tracking ref: refs/heads/main' });
    expect(await detailsHandlers.lastPush({ repo: 1, remoteRef: 'refs/remotes/origin/main' }, ctx)).toBeNull();
    const z = '0'.repeat(40);
    t.memfs.mkdirpSync(`${t.repo.gitdir}/logs/refs/remotes/origin`);
    t.memfs.writeFileSync(`${t.repo.gitdir}/logs/refs/remotes/origin/main`, `${z} ${root} Ada Lovelace <ada@example.com> 1767225700 +0000\tfetch: fast-forward\n${root} ${root} Ada Lovelace <ada@example.com> 1767225800 +0000\tpull: fast-forward\n`);
    expect(await detailsHandlers.lastPush({ repo: 1, remoteRef: 'refs/remotes/origin/main' }, ctx)).toEqual({ time: 1_767_225_700, kind: 'fetch' });
    t.memfs.writeFileSync(`${t.repo.gitdir}/logs/refs/remotes/origin/main`, `${z} ${root} Ada Lovelace <ada@example.com> 1767225900 +0000\tupdate by push\n`);
    expect(await detailsHandlers.lastPush({ repo: 1, remoteRef: 'refs/remotes/origin/main' }, ctx)).toEqual({ time: 1_767_225_900, kind: 'push' });
  });
});
