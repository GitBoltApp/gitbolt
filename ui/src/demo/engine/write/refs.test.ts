import { describe, expect, it } from 'vitest';
import { parseReflog } from '../reflog';
import { makeTestRepo } from '../read/testkit';
import { appendReflog, casRefs, readHead, readRef, setHead, shortRef, ZERO_OID } from './refs';
import { mainWt } from './seam';

describe('refs', () => {
  it('moves refs by CAS: create, update, delete (loose and packed), and refuses a stale old value', async () => {
    const t = await makeTestRepo();
    await t.write('a.txt', 'a\n');
    const one = await t.commit('One');
    await t.write('a.txt', 'b\n');
    const two = await t.commit('Two');
    const demo = t.repo.demo!;
    casRefs(demo, [{ name: 'refs/heads/topic', old: null, new: one }]);
    expect(readRef(demo, 'refs/heads/topic')).toBe(one);
    casRefs(demo, [{ name: 'refs/heads/topic', old: one, new: two }]);
    expect(readRef(demo, 'refs/heads/topic')).toBe(two);
    expect(() => casRefs(demo, [{ name: 'refs/heads/topic', old: one, new: two }])).toThrowError(expect.objectContaining({ kind: 'RefMoved', message: 'topic changed outside GitVolt' }));
    // A packed ref (bundles pack them all) goes from packed-refs too, with its peeled line.
    t.memfs.writeFileSync(`${demo.gitdir}/packed-refs`, `# pack-refs with: peeled fully-peeled sorted \n${one} refs/tags/old\n^${two}\n${two} refs/tags/keep\n`);
    expect(readRef(demo, 'refs/tags/old')).toBe(one);
    casRefs(demo, [{ name: 'refs/tags/old', old: one, new: null }]);
    expect(readRef(demo, 'refs/tags/old')).toBeNull();
    expect(readRef(demo, 'refs/tags/keep')).toBe(two);
    expect(t.memfs.readFileSync(`${demo.gitdir}/packed-refs`, 'utf8')).not.toContain(`^${two}`);
    // All or nothing: one stale move refuses the batch.
    expect(() => casRefs(demo, [{ name: 'refs/heads/x', old: null, new: one }, { name: 'refs/heads/topic', old: one, new: null }])).toThrowError(expect.objectContaining({ kind: 'RefMoved' }));
    expect(readRef(demo, 'refs/heads/x')).toBeNull();
  });

  it("reads and sets the worktree's HEAD, and writes a reflog line", async () => {
    const t = await makeTestRepo();
    await t.write('a.txt', 'a\n');
    const one = await t.commit('One');
    const wt = mainWt(t.repo);
    expect(readHead(wt)).toEqual({ branch: 'main', oid: one });
    setHead(wt, { oid: one });
    expect(readHead(wt)).toEqual({ branch: null, oid: one });
    setHead(wt, { branch: 'unborn' });
    expect(readHead(wt)).toEqual({ branch: 'unborn', oid: null });
    appendReflog(t.repo.demo!, 'refs/stash', null, one, 'You <you@example.com> 1800000000 +0000', 'On main: x');
    const lines = parseReflog(t.memfs.readFileSync(`${t.repo.gitdir}/logs/refs/stash`, 'utf8') as string);
    expect(lines).toEqual([{ old: ZERO_OID, new: one, time: 1_800_000_000, message: 'On main: x' }]);
    expect([shortRef('refs/heads/a/b'), shortRef('refs/remotes/origin/main'), shortRef('refs/tags/v1'), shortRef('refs/stash'), shortRef('HEAD')]).toEqual(['a/b', 'origin/main', 'v1', 'stash', 'HEAD']);
  });

  it('keeps refs/heads when its last branch goes', async () => {
    const t = await makeTestRepo();
    await t.write('a.txt', 'a\n');
    const one = await t.commit('One');
    const demo = t.repo.demo!;
    casRefs(demo, [{ name: 'refs/heads/f/x', old: null, new: one }]);
    casRefs(demo, [{ name: 'refs/heads/f/x', old: one, new: null }, { name: 'refs/heads/main', old: one, new: null }]);
    expect(t.memfs.existsSync(`${demo.gitdir}/refs/heads`)).toBe(true);
    expect(t.memfs.existsSync(`${demo.gitdir}/refs/heads/f`)).toBe(false);
  });

  it('removes a deleted ref\'s reflog with it', async () => {
    const t = await makeTestRepo();
    await t.write('a.txt', 'a\n');
    const one = await t.commit('One');
    const demo = t.repo.demo!;
    casRefs(demo, [{ name: 'refs/heads/topic', old: null, new: one }]);
    appendReflog(demo, 'refs/heads/topic', null, one, 'You <you@example.com> 1 +0000', 'branch: Created');
    casRefs(demo, [{ name: 'refs/heads/topic', old: one, new: null }]);
    expect(demo.fs.existsSync(`${demo.gitdir}/logs/refs/heads/topic`, false)).toBe(false);
  });
});
