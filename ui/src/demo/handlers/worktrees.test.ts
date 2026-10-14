import { describe, expect, it } from 'vitest';
import type { AppEvent } from '../../api/gen/AppEvent';
import type { DemoContext } from '../context';
import { listWorktrees } from '../engine/read/worktrees';
import { addWorktree, fakeCtx, makeTestRepo } from '../engine/read/testkit';
import { branchConfig } from '../engine/write/config';
import { readRef } from '../engine/write/refs';
import { suggestWorktreePath, worktreeHandlers as h } from './worktrees';

async function repo() {
  const t = await makeTestRepo('basic');
  await t.write('a.txt', 'a\n');
  const base = await t.commit('Base');
  await t.branch('feature/x', base);
  return { t, base, ctx: fakeCtx(t.repo) };
}

describe('worktrees', () => {
  it('suggests a free folder beside the main worktree', () => {
    const taken = new Set(['/demo/basic-feature-x']);
    expect([suggestWorktreePath('/demo/basic', 'feature/x', (p) => taken.has(p)), suggestWorktreePath('/demo/basic', 'fix', () => false)]).toEqual(['/demo/basic-feature-x-2', '/demo/basic-fix']);
  });

  it('adds a worktree on an existing branch, a new one and a remote one', async () => {
    const { t, base, ctx } = await repo();
    const r = await h.worktreeAdd({ repo: 1, worktree: t.dir, path: '/demo/basic-feature-x', branch: { kind: 'existing', name: 'feature/x' } }, ctx);
    expect([r.outcome, t.memfs.readFileSync('/demo/basic-feature-x/a.txt', 'utf8'), t.memfs.readFileSync('/demo/basic-feature-x/.git', 'utf8')]).toEqual([{ path: '/demo/basic-feature-x' }, 'a\n', `gitdir: ${t.repo.gitdir}/worktrees/basic-feature-x\n`]);
    expect((await listWorktrees(t.repo)).map((w) => [w.path, w.branch])).toEqual([['/demo/basic', 'refs/heads/main'], ['/demo/basic-feature-x', 'refs/heads/feature/x']]);
    await h.worktreeAdd({ repo: 1, worktree: t.dir, path: '/demo/basic-new', branch: { kind: 'new', name: 'new', at: base } }, ctx);
    t.memfs.writeFileSync(`${t.repo.gitdir}/config`, `${t.memfs.readFileSync(`${t.repo.gitdir}/config`, 'utf8') as string}[remote "origin"]\n\turl = /demo/.origins/basic.git\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n`);
    t.memfs.mkdirpSync(`${t.repo.gitdir}/refs/remotes/origin`);
    t.memfs.writeFileSync(`${t.repo.gitdir}/refs/remotes/origin/topic`, `${base}\n`);
    await h.worktreeAdd({ repo: 1, worktree: t.dir, path: '/demo/basic-topic', branch: { kind: 'remote', remote: 'origin', branch: 'topic', name: 'topic' } }, ctx);
    expect(branchConfig(t.repo.demo!, 'topic')).toEqual(new Map([['branch.topic.remote', ['origin']], ['branch.topic.merge', ['refs/heads/topic']]]));
    expect(ctx.writes.journal(t.dir).undo).toEqual([]);
  });

  it("makes a new branch without a ref move: no refsUpdated, as the core's verify watches no refs here", async () => {
    const { t, base, ctx } = await repo();
    const events: AppEvent[] = [];
    const seen: DemoContext = { ...ctx, emit: (ev: AppEvent) => void events.push(ev) };
    await h.worktreeAdd({ repo: 1, worktree: t.dir, path: '/demo/basic-new', branch: { kind: 'new', name: 'new', at: base } }, seen);
    expect([readRef(t.repo.demo!, 'refs/heads/new'), events.map((e) => e.type).includes('refsUpdated'), events.find((e) => e.type === 'repoChanged')]).toEqual([base, false, expect.objectContaining({ kinds: ['worktree', 'index', 'refs', 'head', 'config'] })]);
  });

  it('refuses a branch checked out elsewhere, a used folder and dash names', async () => {
    const { t, base, ctx } = await repo();
    await expect(h.worktreeAdd({ repo: 1, worktree: t.dir, path: '/demo/basic-main', branch: { kind: 'existing', name: 'main' } }, ctx)).rejects.toMatchObject({ detail: { kind: 'checkedOutElsewhere', branch: 'main', worktree: '/demo/basic' } });
    await expect(h.worktreeAdd({ repo: 1, worktree: t.dir, path: t.dir, branch: { kind: 'new', name: 'n', at: base } }, ctx)).rejects.toMatchObject({ kind: 'InvalidInput', message: "That directory isn't empty" });
    await expect(h.worktreeAdd({ repo: 1, worktree: t.dir, path: '/demo/x', branch: { kind: 'new', name: 'n', at: '-x' } }, ctx)).rejects.toMatchObject({ message: "Names can't start with a dash" });
    await expect(h.worktreeAdd({ repo: 1, worktree: t.dir, path: 'rel', branch: { kind: 'new', name: 'n', at: base } }, ctx)).rejects.toMatchObject({ message: 'Pick a directory inside an existing directory' });
  });

  it("refuses a name a branch's folder holds before it writes anything, in git's words", async () => {
    const { t, base, ctx } = await repo();
    t.memfs.writeFileSync(`${t.repo.gitdir}/config`, `${t.memfs.readFileSync(`${t.repo.gitdir}/config`, 'utf8') as string}[remote "origin"]\n\turl = /demo/.origins/basic.git\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n`);
    t.memfs.mkdirpSync(`${t.repo.gitdir}/refs/remotes/origin`);
    t.memfs.writeFileSync(`${t.repo.gitdir}/refs/remotes/origin/topic`, `${base}\n`);
    await t.branch('topic/x', base);
    const config = t.memfs.readFileSync(`${t.repo.gitdir}/config`, 'utf8');
    await expect(h.worktreeAdd({ repo: 1, worktree: t.dir, path: '/demo/basic-topic', branch: { kind: 'remote', remote: 'origin', branch: 'topic', name: 'topic' } }, ctx)).rejects.toMatchObject({
      kind: 'RefMoved',
      message: "Preparing worktree (new branch 'topic')",
      stderr: "Preparing worktree (new branch 'topic')\nfatal: cannot lock ref 'refs/heads/topic': 'refs/heads/topic/x' exists; cannot create 'refs/heads/topic'\n",
    });
    await expect(h.worktreeAdd({ repo: 1, worktree: t.dir, path: '/demo/basic-deep', branch: { kind: 'new', name: 'feature/x/y', at: base } }, ctx)).rejects.toMatchObject({ kind: 'RefMoved', stderr: expect.stringContaining("'refs/heads/feature/x' exists; cannot create 'refs/heads/feature/x/y'") });
    expect([t.memfs.readFileSync(`${t.repo.gitdir}/config`, 'utf8'), readRef(t.repo.demo!, 'refs/heads/topic'), t.memfs.existsSync('/demo/basic-topic'), (await listWorktrees(t.repo)).length]).toEqual([config, null, false, 1]);
  });

  it('asks for force over changes, removes, and never removes the main worktree', async () => {
    const { t, ctx } = await repo();
    await h.worktreeAdd({ repo: 1, worktree: t.dir, path: '/demo/basic-feature-x', branch: { kind: 'existing', name: 'feature/x' } }, ctx);
    t.memfs.writeFileSync('/demo/basic-feature-x/new.txt', 'n\n');
    const asked = await h.worktreeRemove({ repo: 1, worktree: t.dir, path: '/demo/basic-feature-x', force: false }, ctx);
    expect(asked.outcome).toEqual({ status: 'needsForce', reason: "It has changes that aren't committed" });
    const done = await h.worktreeRemove({ repo: 1, worktree: t.dir, path: '/demo/basic-feature-x', force: true }, ctx);
    expect([done.outcome, t.memfs.existsSync('/demo/basic-feature-x'), t.memfs.existsSync(`${t.repo.gitdir}/worktrees/basic-feature-x`)]).toEqual([{ status: 'removed' }, false, false]);
    await expect(h.worktreeRemove({ repo: 1, worktree: t.dir, path: t.dir, force: true }, ctx)).rejects.toMatchObject({ kind: 'InvalidInput', message: "The main worktree can't be removed" });
    await expect(h.worktreeRemove({ repo: 1, worktree: t.dir, path: '/demo/nope', force: true }, ctx)).rejects.toMatchObject({ kind: 'NotFound', message: "That isn't a worktree of this repository" });
  });
  it('numbers the .git/worktrees id when the name is taken', async () => {
    const { t, ctx } = await repo();
    t.memfs.mkdirpSync('/demo/p');
    t.memfs.mkdirpSync('/demo/q');
    await h.worktreeAdd({ repo: 1, worktree: t.dir, path: '/demo/p/wt', branch: { kind: 'existing', name: 'feature/x' } }, ctx);
    await h.worktreeAdd({ repo: 1, worktree: t.dir, path: '/demo/q/wt', branch: { kind: 'new', name: 'other', at: 'HEAD' } }, ctx);
    expect((t.memfs.readdirSync(`${t.repo.gitdir}/worktrees`) as string[]).sort()).toEqual(['wt', 'wt1']);
    expect(t.memfs.readFileSync('/demo/q/wt/.git', 'utf8')).toBe(`gitdir: ${t.repo.gitdir}/worktrees/wt1\n`);
  });

  it('needs force for a changed tracked file, and the last removal drops .git/worktrees', async () => {
    const { t, ctx } = await repo();
    await h.worktreeAdd({ repo: 1, worktree: t.dir, path: '/demo/basic-feature-x', branch: { kind: 'existing', name: 'feature/x' } }, ctx);
    t.memfs.writeFileSync('/demo/basic-feature-x/a.txt', 'changed\n');
    expect((await h.worktreeRemove({ repo: 1, worktree: t.dir, path: '/demo/basic-feature-x', force: false }, ctx)).outcome).toEqual({ status: 'needsForce', reason: "It has changes that aren't committed" });
    expect(t.memfs.existsSync('/demo/basic-feature-x')).toBe(true);
    await h.worktreeRemove({ repo: 1, worktree: t.dir, path: '/demo/basic-feature-x/', force: true }, ctx);
    expect([t.memfs.existsSync('/demo/basic-feature-x'), t.memfs.existsSync(`${t.repo.gitdir}/worktrees`)]).toEqual([false, false]);
  });

  it('refuses to remove a locked worktree', async () => {
    const { t, ctx } = await repo();
    await h.worktreeAdd({ repo: 1, worktree: t.dir, path: '/demo/basic-feature-x', branch: { kind: 'existing', name: 'feature/x' } }, ctx);
    t.memfs.writeFileSync(`${t.repo.gitdir}/worktrees/basic-feature-x/locked`, '');
    await expect(h.worktreeRemove({ repo: 1, worktree: t.dir, path: '/demo/basic-feature-x', force: true }, ctx)).rejects.toMatchObject({ kind: 'InvalidInput', message: 'This worktree is locked; unlock it first' });
    expect(t.memfs.existsSync('/demo/basic-feature-x')).toBe(true);
  });

  it('suggests from and removes a worktree under /demo/.extra/<name>/<piece>', async () => {
    const { t, ctx } = await repo();
    const wt = await addWorktree(t, 'hot', 'feature/x');
    expect(wt).toBe('/demo/.extra/basic/wt-hot');
    expect(await h.suggestWorktreePath({ repo: 1, branch: 'feature/x' }, ctx)).toBe('/demo/basic-feature-x');
    const done = await h.worktreeRemove({ repo: 1, worktree: wt, path: wt, force: true }, ctx);
    expect([done.outcome, t.memfs.existsSync(wt), t.memfs.existsSync(`${t.repo.gitdir}/worktrees`)]).toEqual([{ status: 'removed' }, false, false]);
  });

  it('resolves a commit-ish start point, and a bad one creates nothing', async () => {
    const { t, base, ctx } = await repo();
    for (const [i, at] of [base, base.slice(0, 8), 'feature/x', 'HEAD'].entries()) {
      await h.worktreeAdd({ repo: 1, worktree: t.dir, path: `/demo/w${i}`, branch: { kind: 'new', name: `n${i}`, at } }, ctx);
      expect(t.memfs.readFileSync(`${t.repo.gitdir}/refs/heads/n${i}`, 'utf8')).toBe(`${base}\n`);
    }
    const before = (t.memfs.readdirSync(`${t.repo.gitdir}/worktrees`) as string[]).length;
    await expect(h.worktreeAdd({ repo: 1, worktree: t.dir, path: '/demo/bad', branch: { kind: 'new', name: 'bad', at: 'nope' } }, ctx)).rejects.toMatchObject({ kind: 'Other', message: 'invalid reference: nope' });
    expect([t.memfs.existsSync('/demo/bad'), t.memfs.existsSync(`${t.repo.gitdir}/refs/heads/bad`), (t.memfs.readdirSync(`${t.repo.gitdir}/worktrees`) as string[]).length]).toEqual([false, false, before]);
  });

  it('normalises the path once: no trailing slash, `..` resolved', async () => {
    const { t, ctx } = await repo();
    const r = await h.worktreeAdd({ repo: 1, worktree: t.dir, path: '/demo/x/../basic-feature-x/', branch: { kind: 'existing', name: 'feature/x' } }, ctx);
    expect(r.outcome).toEqual({ path: '/demo/basic-feature-x' });
    expect(t.memfs.readFileSync(`${t.repo.gitdir}/worktrees/basic-feature-x/gitdir`, 'utf8')).toBe('/demo/basic-feature-x/.git\n');
  });
});
