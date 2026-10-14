import * as git from 'isomorphic-git';
import { describe, expect, it } from 'vitest';
import { makeTestRepo } from '../read/testkit';
import { openForWrite } from '../writeSeamTest';
import { netOf } from './network';
import { readBlobBytes } from '../read/trees';
import { borrowingView, copyReachable, hasObject, peelIn, readCommitIn, remoteRefs } from './objects';
import { commitInOrigin, withOrigin } from './testkit';

describe('objects between git dirs', () => {
  it('an origin borrowing the repo\'s objects has them; its own commit copies back', async () => {
    const t = await makeTestRepo();
    await t.write('a.txt', 'a\n');
    const base = await t.commit('Base');
    const origin = await withOrigin(t, ['main']);
    expect(await hasObject(t.memfs, origin, base)).toBe(true);
    const theirs = await commitInOrigin(t, origin, 'main', 'b.txt', 'b\n', 'Remote change');
    expect(await hasObject(t.memfs, t.repo.gitdir, theirs)).toBe(false);
    const n = await copyReachable(t.memfs, origin, t.repo.gitdir, [theirs]);
    expect(n).toBe(3); // the commit, its tree, the new blob
    expect(await hasObject(t.memfs, t.repo.gitdir, theirs)).toBe(true);
    const { commit } = await git.readCommit({ fs: t.memfs, gitdir: t.repo.gitdir, oid: theirs });
    expect(commit.message).toBe('Remote change\n');
    expect(await copyReachable(t.memfs, origin, t.repo.gitdir, [theirs])).toBe(0);
  });

  it("a borrowing view reads the repository's pack through the repository's cache: one copy of it", async () => {
    const t = await makeTestRepo();
    await t.write('a.txt', 'a\n');
    await t.commit('Base');
    const blob = await git.writeBlob({ fs: t.memfs, gitdir: t.repo.gitdir, blob: new TextEncoder().encode('packed\n') });
    const { filename } = await git.packObjects({ fs: t.memfs, gitdir: t.repo.gitdir, oids: [blob], write: true });
    await git.indexPack({ fs: t.memfs, dir: t.dir, gitdir: t.repo.gitdir, filepath: `.git/objects/pack/${filename}` });
    t.memfs.unlinkSync(`${t.repo.gitdir}/objects/${blob.slice(0, 2)}/${blob.slice(2)}`);
    const origin = await withOrigin(t, ['main']);
    const view = await borrowingView(t.memfs, origin);
    // Only the borrowing view has read it: its index is in the repository's cache (an isomorphic-git
    // that renamed its PackfileCache symbol would put it in the view's own).
    expect(new TextDecoder().decode(await readBlobBytes(view, blob))).toBe('packed\n');
    const packs = (cache: object) => Object.getOwnPropertySymbols(cache).flatMap((k) => [...((cache as Record<symbol, Map<string, unknown>>)[k]?.keys?.() ?? [])]);
    expect(packs(t.repo.cache)).toEqual([`${t.repo.gitdir}/objects/pack/${filename.replace(/pack$/, 'idx')}`]);
    expect(packs(view.cache)).toEqual([]);
    expect(await hasObject(t.memfs, t.repo.gitdir, blob)).toBe(true);
  });

  it('reads through alternates, follows an annotated tag, and lists refs with symbolic and virtual ones', async () => {
    const t = await makeTestRepo();
    await t.write('a.txt', 'a\n');
    const base = await t.commit('Base');
    const origin = await withOrigin(t, ['main']);
    expect((await readCommitIn(t.memfs, origin, base)).message).toBe('Base\n');
    const theirs = await commitInOrigin(t, origin, 'main', 'b.txt', 'b\n', 'Remote change');
    const tagger = { name: 'Noor Achterberg', email: 'noor.achterberg@example.com', timestamp: 1_767_300_000, timezoneOffset: 0 };
    const tag = await git.writeTag({ fs: t.memfs, gitdir: origin, tag: { object: theirs, type: 'commit', tag: 'v1', tagger, message: 'One\n' } });
    await git.writeRef({ fs: t.memfs, gitdir: origin, ref: 'refs/tags/v1', value: tag });
    expect(await peelIn(t.memfs, origin, tag)).toBe(theirs);
    expect(await peelIn(t.memfs, origin, base)).toBe(base);
    expect(await copyReachable(t.memfs, origin, t.repo.gitdir, [tag])).toBe(4); // the tag and the commit's three
    expect((await readCommitIn(t.memfs, t.repo.gitdir, theirs)).parent).toEqual([base]);
    const { ctx } = await openForWrite(t);
    netOf(ctx).virtualRefs.push(async () => new Map([['refs/merge-requests/1/head', base]]));
    t.memfs.writeFileSync(`${origin}/refs/heads/alias`, 'ref: refs/heads/main\n');
    expect([...(await remoteRefs(ctx, t.memfs, origin))]).toEqual([
      ['refs/heads/alias', theirs],
      ['refs/heads/main', theirs],
      ['refs/tags/v1', tag],
      ['refs/merge-requests/1/head', base],
    ]);
  });

  it('chains commits made in the origin; a copy missing an ancestor writes nothing, and a retry completes', async () => {
    const t = await makeTestRepo();
    await t.write('a.txt', 'a\n');
    const base = await t.commit('Base');
    const origin = await withOrigin(t, ['main']);
    const first = await commitInOrigin(t, origin, 'main', 'b.txt', 'b\n', 'First');
    const second = await commitInOrigin(t, origin, 'main', 'c.txt', 'c\n', 'Second');
    expect((await readCommitIn(t.memfs, origin, second)).parent).toEqual([first]);
    expect((await readCommitIn(t.memfs, origin, first)).parent).toEqual([base]);
    const loose = `${origin}/objects/${first.slice(0, 2)}/${first.slice(2)}`;
    const bytes = t.memfs.readFileSync(loose) as Uint8Array;
    t.memfs.unlinkSync(loose);
    await expect(copyReachable(t.memfs, origin, t.repo.gitdir, [second])).rejects.toMatchObject({ kind: 'NotFound' });
    const secondTree = (await readCommitIn(t.memfs, origin, second)).tree;
    expect(await hasObject(t.memfs, t.repo.gitdir, second)).toBe(false);
    expect(await hasObject(t.memfs, t.repo.gitdir, secondTree)).toBe(false);
    t.memfs.writeFileSync(loose, bytes);
    expect(await copyReachable(t.memfs, origin, t.repo.gitdir, [second])).toBe(6); // two commits, two trees, two blobs
    const { commit } = await git.readCommit({ fs: t.memfs, gitdir: t.repo.gitdir, oid: second });
    expect(commit.parent).toEqual([first]);
    expect(await hasObject(t.memfs, t.repo.gitdir, first)).toBe(true);
  });
});

