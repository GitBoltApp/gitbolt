import * as git from 'isomorphic-git';
import { describe, expect, it } from 'vitest';
import { makeTestRepo } from '../read/testkit';
import { openForWrite } from '../writeSeamTest';
import { remoteHandlers } from '../../handlers/remotes';
import { netOf } from './network';
import { startTeammate, teammatePush, TEAMMATE_REF } from './teammate';
import { commitInOrigin, withOrigin } from './testkit';

async function withTeammate() {
  const t = await makeTestRepo();
  await t.commit('Base');
  const origin = await withOrigin(t, ['main']);
  const base = await t.rev('main');
  const theirs = await commitInOrigin(t, origin, 'main', 'music.txt', 'volume 0.8\n', 'Turn the menu music down a little');
  await git.writeRef({ fs: t.memfs, gitdir: origin, ref: TEAMMATE_REF, value: theirs });
  await git.writeRef({ fs: t.memfs, gitdir: origin, ref: 'refs/heads/main', value: base, force: true });
  return { t, origin, base, theirs };
}

describe('the teammate', () => {
  it('pushes once, as a fast-forward', async () => {
    const { t, origin, base, theirs } = await withTeammate();
    expect(await teammatePush(t.memfs, origin)).toEqual({ old: base, new: theirs });
    expect(await git.resolveRef({ fs: t.memfs, gitdir: origin, ref: 'refs/heads/main' })).toBe(theirs);
    expect(await teammatePush(t.memfs, origin)).toBeNull();
  });

  it('gives up once the visitor moved main elsewhere', async () => {
    const { t, origin } = await withTeammate();
    await commitInOrigin(t, origin, 'main', 'mine.txt', 'mine\n', 'The visitor pushed first');
    const moved = await git.resolveRef({ fs: t.memfs, gitdir: origin, ref: 'refs/heads/main' });
    expect(await teammatePush(t.memfs, origin)).toBeNull();
    expect(await git.resolveRef({ fs: t.memfs, gitdir: origin, ref: 'refs/heads/main' })).toBe(moved);
  });

  it('the first network op triggers the teammate, however early; its push tells the origin\'s listeners (the forge)', async () => {
    const { t, origin, base, theirs } = await withTeammate();
    const { ctx, id } = await openForWrite(t);
    netOf(ctx).latencyMs = 0;
    const timers: (() => void)[] = [];
    netOf(ctx).schedule = (_ms, f) => void timers.push(f);
    const heard: unknown[] = [];
    netOf(ctx).afterPush.push(async (_fs, gitdir, moved) => void heard.push([gitdir, moved]));
    startTeammate(ctx, t.memfs);
    expect(timers).toHaveLength(1);
    await remoteHandlers.fetch({ repo: id, background: false }, ctx);
    expect(await t.rev('refs/remotes/origin/main')).toBe(theirs);
    expect(heard).toEqual([[origin, [{ ref: 'refs/heads/main', old: base, new: theirs }]]]);
  });
});
