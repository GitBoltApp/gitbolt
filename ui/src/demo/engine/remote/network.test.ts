import { describe, expect, it } from 'vitest';
import { makeTestRepo } from '../read/testkit';
import { openForWrite } from '../writeSeamTest';
import { resolveRemote } from './network';
import { demoRoot } from '../paths';
import { withOrigin } from './testkit';

describe('resolveRemote', () => {
  it('reaches an in-memory git dir by path', async () => {
    const t = await makeTestRepo();
    await t.commit('Base');
    const origin = await withOrigin(t, ['main']);
    const { ctx } = await openForWrite(t);
    expect(await resolveRemote(ctx, t.memfs, origin, 'fetching from')).toBe(origin);
    expect(await resolveRemote(ctx, t.memfs, `file://${origin}`, 'fetching from')).toBe(origin);
    expect(await resolveRemote(ctx, t.memfs, `${t.dir}/`, 'pushing to')).toBe(t.repo.gitdir);
  });

  it("maps a bundle's forge project URL (Orbital's and the stack's origins) to its bundled origin", async () => {
    for (const [name, project] of [['orbital', 'orbital/orbital'], ['stack', 'orbital/cargo']]) {
      const t = await makeTestRepo(name);
      await t.commit('Base');
      const origin = await withOrigin(t, ['main']);
      expect(origin).toBe(demoRoot(name, 'origin.git'));
      t.memfs.mkdirpSync(demoRoot(name, 'forge.json').replace(/\/[^/]+$/, ''));
      t.memfs.writeFileSync(demoRoot(name, 'forge.json'), JSON.stringify({ version: 1, host: 'gitlab.example.com', project, me: 'you', gitlab: {} }));
      const { ctx } = await openForWrite(t);
      expect(await resolveRemote(ctx, t.memfs, `https://gitlab.example.com/${project}.git`, 'fetching from')).toBe(origin);
      expect(await resolveRemote(ctx, t.memfs, `git@gitlab.example.com:${project}.git`, 'pushing to')).toBe(origin);
      await expect(resolveRemote(ctx, t.memfs, 'https://gitlab.example.com/orbital/elsewhere.git', 'fetching from')).rejects.toMatchObject({ message: 'Not in the demo: fetching from gitlab.example.com' });
    }
  });

  it('an unknown host is not in the demo, and says so without the URL\'s secrets', async () => {
    const t = await makeTestRepo();
    await t.commit('Base');
    const { ctx } = await openForWrite(t);
    await expect(resolveRemote(ctx, t.memfs, 'https://user:tok@github.com/o/r.git', 'fetching from')).rejects.toMatchObject({ kind: 'Other', message: 'Not in the demo: fetching from github.com' });
    await expect(resolveRemote(ctx, t.memfs, 'git@code.example.com:o/r.git', 'pushing to')).rejects.toMatchObject({ message: 'Not in the demo: pushing to code.example.com' });
    await expect(resolveRemote(ctx, t.memfs, '/demo/.origins/nowhere.git', 'fetching from')).rejects.toMatchObject({ message: 'Not in the demo: fetching from /demo/.origins/nowhere.git' });
  });
});
