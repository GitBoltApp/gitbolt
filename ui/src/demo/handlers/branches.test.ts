import { describe, expect, it } from 'vitest';
import { readRaw } from '../engine/read/trees';
import { addWorktree, fakeCtx, makeTestRepo, type TestRepo } from '../engine/read/testkit';
import { branchConfig } from '../engine/write/config';
import { casRefs, readHead, setHead } from '../engine/write/refs';
import { mainWt } from '../engine/write/seam';
import { stashList } from '../engine/write/stash';
import { checkedOutElsewhere, displayWorktree, elsewhere } from '../engine/write/checkedOut';
import { branchHandlers } from './branches';

const NO = { head: null, refs: {} };

async function repo() {
  const t = await makeTestRepo();
  await t.write('a.txt', 'a\n');
  const base = await t.commit('Base');
  await t.write('a.txt', 'b\n');
  const next = await t.commit('Next');
  return { t, base, next, ctx: fakeCtx(t.repo), demo: t.repo.demo! };
}

function addOrigin(t: TestRepo, branch: string, oid: string): void {
  const cfg = `${t.repo.gitdir}/config`;
  t.memfs.writeFileSync(cfg, `${t.memfs.readFileSync(cfg, 'utf8') as string}[remote "origin"]\n\turl = /demo/.origins/test.git\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n`);
  t.memfs.mkdirpSync(`${t.repo.gitdir}/refs/remotes/origin`);
  t.memfs.writeFileSync(`${t.repo.gitdir}/refs/remotes/origin/${branch}`, `${oid}\n`);
}

function appendConfig(t: TestRepo, text: string): void {
  const cfg = `${t.repo.gitdir}/config`;
  t.memfs.writeFileSync(cfg, `${t.memfs.readFileSync(cfg, 'utf8') as string}${text}`);
}

describe('createBranch', () => {
  it('tracks a remote-tracking start and journals the config it wrote', async () => {
    const { t, base, ctx, demo } = await repo();
    addOrigin(t, 'topic', base);
    const r = await branchHandlers.createBranch({ repo: 1, worktree: t.dir, name: 'topic', start: base, startRef: 'refs/remotes/origin/topic', checkout: false, expect: NO }, ctx);
    expect([await t.rev('topic'), r.outcome, r.journal.undo?.label]).toEqual([base, null, 'create branch topic']);
    expect(branchConfig(demo, 'topic')).toEqual(new Map([['branch.topic.remote', ['origin']], ['branch.topic.merge', ['refs/heads/topic']]]));
    const e = ctx.writes.journal(t.dir).undoTop()!;
    expect([e.undo, e.config.map((c) => c.key)]).toEqual(['moveRefs', ['branch.topic.remote', 'branch.topic.merge']]);
  });

  it('follows branch.autoSetupMerge', async () => {
    const { t, base, ctx, demo } = await repo();
    appendConfig(t, '[branch]\n\tautoSetupMerge = always\n');
    await branchHandlers.createBranch({ repo: 1, worktree: t.dir, name: 'local', start: base, startRef: 'refs/heads/main', checkout: false, expect: NO }, ctx);
    expect(branchConfig(demo, 'local').get('branch.local.remote')).toEqual(['.']);
    addOrigin(t, 'topic', base);
    appendConfig(t, '[branch]\n\tautoSetupMerge = false\n');
    await branchHandlers.createBranch({ repo: 1, worktree: t.dir, name: 'topic', start: base, startRef: 'refs/remotes/origin/topic', checkout: false, expect: NO }, ctx);
    expect(branchConfig(demo, 'topic').size).toBe(0);
  });

  it('checks the new branch out, moving the worktree', async () => {
    const { t, base, ctx } = await repo();
    const r = await branchHandlers.createBranch({ repo: 1, worktree: t.dir, name: 'older', start: base, checkout: true, expect: NO }, ctx);
    expect([readHead(mainWt(t.repo)), t.memfs.readFileSync(`${t.dir}/a.txt`, 'utf8'), ctx.writes.journal(t.dir).undoTop()?.undo, r.wip?.unstaged.files]).toEqual([{ branch: 'older', oid: base }, 'a\n', 'switch', []]);
  });

  it('refuses a bad name, a taken one, and a start that is not a commit, changing nothing', async () => {
    const { t, base, ctx } = await repo();
    const create = (name: string, start = base) => branchHandlers.createBranch({ repo: 1, worktree: t.dir, name, start, checkout: false, expect: NO }, ctx);
    await expect(create('bad name')).rejects.toMatchObject({ kind: 'InvalidInput', message: "A branch name can't contain spaces or ~ ^ : ? * [ \\" });
    await expect(create('main')).rejects.toMatchObject({ kind: 'InvalidInput', message: 'A branch named main already exists' });
    const { readCommit } = await import('../engine/read/commitText');
    const tree = (await readCommit(t.repo, base)).tree;
    await expect(create('x', tree)).rejects.toMatchObject({ kind: 'InvalidInput', message: `${tree} isn't a commit in this repository` });
    expect(ctx.writes.journal(t.dir).undo).toEqual([]);
  });
});

describe('renameBranch and setUpstream', () => {
  it('renames the checked-out branch and one checked out elsewhere, with their config', async () => {
    const { t, base, ctx, demo } = await repo();
    appendConfig(t, '[branch "main"]\n\tdescription = trunk\n');
    await t.branch('feature', base);
    const side = await addWorktree(t, 'side', 'feature');
    await branchHandlers.renameBranch({ repo: 1, worktree: t.dir, from: 'main', to: 'trunk', expect: NO }, ctx);
    expect([readHead(mainWt(t.repo)).branch, branchConfig(demo, 'trunk').get('branch.trunk.description'), ctx.writes.journal(t.dir).undoTop()?.undo]).toEqual(['trunk', ['trunk'], 'rename']);
    await branchHandlers.renameBranch({ repo: 1, worktree: t.dir, from: 'feature', to: 'feat', expect: NO }, ctx);
    expect(t.memfs.readFileSync(`${t.repo.gitdir}/worktrees/side/HEAD`, 'utf8')).toBe('ref: refs/heads/feat\n');
    void side;
    await expect(branchHandlers.renameBranch({ repo: 1, worktree: t.dir, from: 'nope', to: 'x', expect: NO }, ctx)).rejects.toMatchObject({ kind: 'NotFound', message: 'No branch nope' });
    await expect(branchHandlers.renameBranch({ repo: 1, worktree: t.dir, from: 'feat', to: 'trunk', expect: NO }, ctx)).rejects.toMatchObject({ message: 'A branch named trunk already exists' });
  });

  it('sets, adds and unsets an upstream without journaling it', async () => {
    const { t, base, ctx, demo } = await repo();
    addOrigin(t, 'main', base);
    await branchHandlers.setUpstream({ repo: 1, worktree: t.dir, branch: 'main', upstream: { remote: 'origin', branch: 'main' } }, ctx);
    expect(branchConfig(demo, 'main')).toEqual(new Map([['branch.main.remote', ['origin']], ['branch.main.merge', ['refs/heads/main']]]));
    await branchHandlers.setUpstream({ repo: 1, worktree: t.dir, branch: 'main', upstream: { remote: 'origin', branch: 'later' } }, ctx);
    expect(branchConfig(demo, 'main').get('branch.main.merge')).toEqual(['refs/heads/later']);
    await branchHandlers.setUpstream({ repo: 1, worktree: t.dir, branch: 'main', upstream: null }, ctx);
    expect(branchConfig(demo, 'main').size).toBe(0);
    await expect(branchHandlers.setUpstream({ repo: 1, worktree: t.dir, branch: 'main', upstream: { remote: 'upstream', branch: 'main' } }, ctx)).rejects.toMatchObject({ kind: 'NotFound', message: 'No remote upstream' });
    expect(ctx.writes.journal(t.dir).undo).toEqual([]);
  });
});

describe('deleteBranch and fastForward', () => {
  it('asks before deleting unmerged work, then forces, removing the config', async () => {
    const { t, base, next, ctx, demo } = await repo();
    await t.branch('feature', next);
    casRefs(demo, [{ name: 'refs/heads/main', old: next, new: base }]);
    setHead(mainWt(t.repo), { branch: 'main' });
    appendConfig(t, '[branch "feature"]\n\tremote = .\n\tmerge = refs/heads/nowhere\n');
    const del = (force: boolean) => branchHandlers.deleteBranch({ repo: 1, worktree: t.dir, branch: 'feature', local: true, remote: null, force, expect: NO }, ctx);
    expect((await del(false)).outcome).toEqual({ status: 'unmerged', branch: 'feature', into: 'main', commits: 1 });
    expect([await t.rev('feature'), ctx.writes.journal(t.dir).undo]).toEqual([next, []]);
    await del(true);
    expect([demo.resolveRef(demo.refMap(), 'refs/heads/feature'), branchConfig(demo, 'feature').size]).toEqual([null, 0]);
    expect(ctx.writes.journal(t.dir).undoTop()?.config.map((c) => c.key)).toEqual(['branch.feature.remote', 'branch.feature.merge']);
  });

  it('never deletes a checked-out branch; a remote leg checks its lease first', async () => {
    const { t, base, ctx } = await repo();
    await t.branch('feature', base);
    await addWorktree(t, 'side', 'feature');
    const del = (branch: string, remote: { remote: string; branch: string; lease: string } | null = null) =>
      branchHandlers.deleteBranch({ repo: 1, worktree: t.dir, branch, local: true, remote, force: true, expect: NO }, ctx);
    await expect(del('main')).rejects.toMatchObject({ kind: 'InvalidInput', message: 'main is checked out' });
    await expect(del('feature')).rejects.toMatchObject({ kind: 'InvalidInput', message: 'feature is checked out in ../wt-side.', detail: { kind: 'checkedOutElsewhere', branch: 'feature', worktree: '../wt-side' } });
    await expect(del('feature', { remote: 'origin', branch: 'feature', lease: base })).rejects.toMatchObject({ kind: 'RefMoved', message: 'origin/feature changed outside GitVolt' });
  });

  it('fast-forwards a branch that is not checked out', async () => {
    const { t, base, ctx } = await repo();
    await t.branch('feature', base);
    const ff = (branch: string, to: string) => branchHandlers.fastForward({ repo: 1, worktree: t.dir, branch, to, expect: NO }, ctx);
    const r = await ff('feature', 'refs/heads/main');
    expect([r.outcome, r.journal.undo?.label]).toEqual([{ status: 'done', commits: 1, fastForward: true }, 'fast-forward feature to main']);
    expect((await ff('feature', 'refs/heads/main')).outcome).toEqual({ status: 'upToDate' });
    await expect(ff('main', 'refs/heads/feature')).rejects.toMatchObject({ kind: 'InvalidInput', message: `main is checked out in ${t.dir}` });
    await t.checkout('feature');
    await t.write('a.txt', 'side\n');
    await t.commit('Side');
    await t.checkout('main');
    await t.branch('other', base);
    await expect(ff('feature', `refs/heads/other`)).rejects.toMatchObject({ kind: 'NonFastForward', message: 'feature has commits other doesn\'t have' });
  });
});

describe('tags', () => {
  it('creates lightweight and annotated tags, and deletes one', async () => {
    const { t, base, ctx, demo } = await repo();
    const create = (name: string, message?: string) => branchHandlers.createTag({ repo: 1, worktree: t.dir, name, target: base, ...(message === undefined ? {} : { message }) }, ctx);
    await create('v1');
    expect(demo.resolveRef(demo.refMap(), 'refs/tags/v1')).toBe(base);
    await create('v2', 'Release 2\n\n# not kept\nNotes.  \n\n');
    const id = demo.resolveRef(demo.refMap(), 'refs/tags/v2')!;
    const raw = await readRaw(t.repo, id);
    expect([raw?.type, new TextDecoder().decode(raw!.bytes)]).toEqual(['tag', `object ${base}\ntype commit\ntag v2\ntagger You <you@example.com> 1800000000 +0000\n\nRelease 2\n\nNotes.\n`]);
    expect(ctx.writes.journal(t.dir).undoTop()?.label).toBe('create tag v2');
    await expect(create('v1')).rejects.toMatchObject({ kind: 'InvalidInput', message: 'A tag named v1 already exists' });
    await expect(create('v3', '  ')).rejects.toMatchObject({ kind: 'InvalidInput', message: 'Enter a tag message' });
    await expect(create('-v')).rejects.toMatchObject({ kind: 'InvalidInput', message: "A tag name can't start with -" });
    await branchHandlers.deleteTag({ repo: 1, worktree: t.dir, name: 'v1', local: true }, ctx);
    expect(demo.resolveRef(demo.refMap(), 'refs/tags/v1')).toBeNull();
    await expect(branchHandlers.deleteTag({ repo: 1, worktree: t.dir, name: 'v1', local: true }, ctx)).rejects.toMatchObject({ kind: 'NotFound', message: 'No tag v1' });
    await expect(branchHandlers.deleteTag({ repo: 1, worktree: t.dir, name: 'v2', local: true, remote: 'origin' }, ctx)).rejects.toMatchObject({ kind: 'NotFound', message: "'origin' does not appear to be a git repository" });
    expect(demo.resolveRef(demo.refMap(), 'refs/tags/v2')).toBe(id);
  });
});

describe('create and check out over a dirty tree', () => {
  it('asks before an autostash whose restore conflicts, leaving no branch, config, journal entry or stash', async () => {
    const { t, base, ctx, demo } = await repo();
    addOrigin(t, 'older', base);
    await t.write('a.txt', 'dirty\n');
    const create = (confirmAutostash: boolean) => branchHandlers.createBranch({ repo: 1, worktree: t.dir, name: 'older', start: base, startRef: 'refs/remotes/origin/older', checkout: true, expect: NO, confirmAutostash }, ctx);
    await expect(create(false)).rejects.toMatchObject({ kind: 'Conflict', message: 'Your changes conflict with older', detail: { kind: 'autostashConflict', paths: ['a.txt'], target: 'older' } });
    expect([demo.resolveRef(demo.refMap(), 'refs/heads/older'), branchConfig(demo, 'older').size, ctx.writes.journal(t.dir).undo, stashList(mainWt(t.repo))]).toEqual([null, 0, [], []]);
    const r = await create(true);
    expect([readHead(mainWt(t.repo)).branch, r.journal.banners.map((b) => [b.kind, b.label, b.stashMessage, b.files])]).toEqual(['older', [['autostashConflicts', 'create branch older', 'autostash before checkout older', 1]]]);
  });
});

describe('checkedOut', () => {
  it('names a worktree beside the main one relatively, and builds the refusal', () => {
    expect([displayWorktree('/demo/shop', '/demo/shop-x'), displayWorktree('/demo/shop', '/elsewhere/x'), displayWorktree('/demo/shop', '/demo/.extra/shop/wt-a'), displayWorktree('/demo/shop', '/demo/shop')]).toEqual(['../shop-x', '/elsewhere/x', '../wt-a', '/demo/shop']);
    expect(checkedOutElsewhere('f', '../x')).toMatchObject({ kind: 'InvalidInput', message: 'f is checked out in ../x.', detail: { kind: 'checkedOutElsewhere', branch: 'f', worktree: '../x' } });
  });
});

describe('deleteBranch on an unborn HEAD', () => {
  it('fails as rev-list does, not as unmerged', async () => {
    const { t, base, ctx } = await repo();
    await t.branch('feature', base);
    setHead(mainWt(t.repo), { branch: 'unborn' });
    await expect(branchHandlers.deleteBranch({ repo: 1, worktree: t.dir, branch: 'feature', local: true, remote: null, force: false, expect: NO }, ctx)).rejects.toMatchObject({ kind: 'NotFound', message: "bad revision 'HEAD..refs/heads/feature'" });
  });
});

describe('elsewhere', () => {
  it('names the other worktree holding a branch, else null', async () => {
    const { t, base } = await repo();
    await t.branch('feature', base);
    await addWorktree(t, 'side', 'feature');
    const wt = mainWt(t.repo);
    expect([await elsewhere(wt, 'refs/heads/feature'), await elsewhere(wt, 'refs/heads/main'), await elsewhere(wt, 'refs/heads/nope')]).toEqual(['../wt-side', null, null]);
  });
});
