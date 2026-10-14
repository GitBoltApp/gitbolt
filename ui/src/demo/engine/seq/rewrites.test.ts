import * as git from 'isomorphic-git';
import { describe, expect, it } from 'vitest';
import { makeTestRepo, type TestRepo } from '../read/testkit';
import { leaseFor, pushed, recordRewrite, rewrittenOf } from './rewrites';

const YOU = { name: 'You', email: 'you@example.com' };

/** `dev` pushed to origin (a tracking ref), then rewritten by "you". */
async function pushedDev(): Promise<{ t: TestRepo; old: string; rewritten: string }> {
  const t = await makeTestRepo();
  await t.commit('Base');
  await t.branch('dev');
  await t.checkout('dev');
  await t.write('d.txt', 'dev\n');
  const old = await t.commit('Dev work', YOU);
  await git.writeRef({ fs: t.memfs, dir: t.dir, ref: 'refs/remotes/origin/dev', value: old });
  await git.setConfig({ fs: t.memfs, dir: t.dir, path: 'remote.origin.url', value: '/demo/.origins/test.git' });
  await git.setConfig({ fs: t.memfs, dir: t.dir, path: 'branch.dev.remote', value: 'origin' });
  await git.setConfig({ fs: t.memfs, dir: t.dir, path: 'branch.dev.merge', value: 'refs/heads/dev' });
  await t.write('d.txt', 'dev, amended\n');
  const rewritten = await t.commit('Dev work, amended', YOU, { parents: [await t.rev('main')] });
  await git.writeRef({ fs: t.memfs, dir: t.dir, ref: 'refs/heads/dev', value: rewritten, force: true });
  return { t, old, rewritten };
}
const target = { remote: 'origin', branch: 'dev' };

describe('rewrite marks', () => {
  it("a rewrite of the visitor's own pushed commits leases the old remote tip, once", async () => {
    const { t, old, rewritten } = await pushedDev();
    await recordRewrite(t.repo, 'amend', [{ name: 'refs/heads/dev', old, new: rewritten }], 'you@example.com');
    expect(await leaseFor(t.repo, 'dev', target)).toMatchObject({ mark: { leaseOid: old, kind: 'amend' }, tip: rewritten });
    expect(await rewrittenOf(t.repo, 'dev')).toEqual({ kind: 'amend', remote: 'origin' });
    pushed(t.repo, 'dev');
    expect(await leaseFor(t.repo, 'dev', target)).toBeNull();
  });

  it("someone else's commits get no mark", async () => {
    const { t, old, rewritten } = await pushedDev();
    await recordRewrite(t.repo, 'amend', [{ name: 'refs/heads/dev', old, new: rewritten }], 'grace@example.com');
    expect(await leaseFor(t.repo, 'dev', target)).toBeNull();
  });

  it('a later reset off the rewrite drops the mark', async () => {
    const { t, old, rewritten } = await pushedDev();
    await recordRewrite(t.repo, 'rebase', [{ name: 'refs/heads/dev', old, new: rewritten }], 'you@example.com');
    await recordRewrite(t.repo, null, [{ name: 'refs/heads/dev', old: rewritten, new: old }]);
    expect(await rewrittenOf(t.repo, 'dev')).toBeNull();
  });

  it('an empty identity email records nothing, and a fetch that moves the tracking ref hides the mark', async () => {
    const { t, old, rewritten } = await pushedDev();
    await recordRewrite(t.repo, 'amend', [{ name: 'refs/heads/dev', old, new: rewritten }], ' ');
    expect(await leaseFor(t.repo, 'dev', target)).toBeNull();
    await recordRewrite(t.repo, 'amend', [{ name: 'refs/heads/dev', old, new: rewritten }], 'you@example.com');
    await git.writeRef({ fs: t.memfs, dir: t.dir, ref: 'refs/remotes/origin/dev', value: await t.rev('main'), force: true });
    expect(await rewrittenOf(t.repo, 'dev')).toBeNull();
  });
});
