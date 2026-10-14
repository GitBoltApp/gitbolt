import { readFileSync } from 'node:fs';
import * as git from 'isomorphic-git';
import { describe, expect, test, vi } from 'vitest';
import { GOLDEN, goldenData, goldenManifest, noGraph } from '../testing';
import { readBundle } from './bundle';
import { MemFs } from './memfs';
import { DemoRepo, isClean } from './repo';
import { DemoRepos } from './repos';

async function basic() {
  const fs = new MemFs();
  const repo = await DemoRepo.load(fs, await readBundle(new Uint8Array(readFileSync(`${GOLDEN}/basic.gbdemo`))), noGraph());
  return { fs, repo };
}

const clean = { modified: 0, added: 0, deleted: 0, renamed: 0, conflicted: 0 };

describe('DemoRepo on the basic fixture', () => {
  test('isomorphic-git reads a harness repository: a pack, packed refs, reflogs', async () => {
    const { fs, repo } = await basic();
    expect(fs.existsSync('/demo/basic/.git/packed-refs')).toBe(true);
    expect(fs.existsSync('/demo/.origins/basic.git/HEAD')).toBe(true);
    expect(repo.refFiles().find((f) => f.full === 'refs/remotes/origin/HEAD')?.symref).toBe('refs/remotes/origin/main');
    const head = repo.head(repo.refMap());
    expect([head.branch, head.detached, head.unborn]).toEqual(['refs/heads/main', false, false]);
    expect(repo.commits.get(head.target ?? '')?.message.startsWith("Merge branch 'feature/login'")).toBe(true);
    expect([...repo.commits.values()].some((c) => c.message.startsWith('Initial commit'))).toBe(true);
    expect(repo.stashes().map((s) => [s.index, s.message])).toEqual([[0, 'On main: Experiment']]);
    expect(await repo.remotes()).toEqual([{ name: 'origin', url: '/demo/.origins/basic.git' }]);
  });

  test('each worktree has its own HEAD and status (an index v2 each)', async () => {
    const { fs, repo } = await basic();
    const ws = await repo.worktrees();
    expect(ws.map((w) => [w.path, w.branch, w.isMain, w.prunable, w.locked])).toEqual([
      ['/demo/basic', 'refs/heads/main', true, false, false],
      ['/demo/.extra/basic/wt-hotfix', 'refs/heads/hotfix', false, false, false],
    ]);
    expect(await repo.wipCounts(ws[0])).toEqual({ ...clean, modified: 1 });
    expect(await repo.wipCounts(ws[1])).toEqual({ ...clean, modified: 1 });
    expect(fs.readFileSync('/demo/basic/.git/HEAD', 'utf8')).toBe('ref: refs/heads/main\n');
    expect(fs.readFileSync('/demo/basic/.git/worktrees/wt-hotfix/HEAD', 'utf8')).toBe('ref: refs/heads/hotfix\n');
  });

  test("every git dir gets the skeleton a bundle can't carry", async () => {
    const { fs } = await basic();
    for (const gitdir of ['/demo/basic/.git', '/demo/.origins/basic.git']) {
      for (const sub of ['refs/heads', 'refs/tags', 'objects/info', 'objects/pack']) expect(fs.statSync(`${gitdir}/${sub}`).isDirectory()).toBe(true);
    }
    expect(fs.existsSync('/demo/basic/.git/worktrees/wt-hotfix/refs')).toBe(false);
    // The bare origin keeps all its refs packed: isomorphic-git writes a loose one beside them.
    const origin = '/demo/.origins/basic.git';
    await git.writeRef({ fs, gitdir: origin, ref: 'refs/heads/next', value: await git.resolveRef({ fs, gitdir: origin, ref: 'main' }) });
    expect(await git.listBranches({ fs, gitdir: origin })).toEqual(['feature/login', 'main', 'next']);
  });

  test('a skeleton goes only where git dirs live: not into a tracked folder that looks like one', async () => {
    const bundle = await readBundle(new Uint8Array(readFileSync(`${GOLDEN}/basic.gbdemo`)));
    const text = (path: string, s: string) => ({ path, mode: 0o100644, data: new TextEncoder().encode(s) });
    bundle.files.push(
      text('repo/docs/HEAD', 'ref: refs/heads/main\n'),
      text('repo/docs/config', '[core]\n'),
      text('repo/.git/modules/libs/ui/HEAD', 'ref: refs/heads/main\n'),
      text('repo/.git/modules/libs/ui/config', '[core]\n\tworktree = ../../../../libs/ui\n'),
    );
    const fs = new MemFs();
    await DemoRepo.load(fs, bundle, noGraph());
    expect(fs.readdirSync('/demo/basic/docs').sort()).toEqual(['HEAD', 'config']);
    expect(fs.statSync('/demo/basic/.git/modules/libs/ui/objects/pack').isDirectory()).toBe(true);
    expect(fs.statSync('/demo/basic/.git/modules/libs/ui/refs/tags').isDirectory()).toBe(true);
  });

  test('a submodule folder is made at its quoted .gitmodules path, and a comment after it is not part of the path', async () => {
    const bundle = await readBundle(new Uint8Array(readFileSync(`${GOLDEN}/basic.gbdemo`)));
    bundle.files.push({ path: 'repo/.gitmodules', mode: 0o100644, data: new TextEncoder().encode('[submodule "ui"]\n\tpath = "libs/my ui" # the widgets\n\turl = ../ui\n') });
    // Only a file named exactly `.gitmodules` lists submodules.
    bundle.files.push({ path: 'repo/notes.gitmodules', mode: 0o100644, data: new TextEncoder().encode('[submodule "x"]\n\tpath = not-a-module\n') });
    const fs = new MemFs();
    await DemoRepo.load(fs, bundle, noGraph());
    expect(fs.statSync('/demo/basic/libs/my ui').isDirectory()).toBe(true);
    expect(fs.existsSync('/demo/basic/libs/my ui" # the widgets')).toBe(false);
    expect(fs.readdirSync('/demo/basic').filter((n) => n.includes('not-a-module'))).toEqual([]);
  });

  test('loads without WebCrypto: the index stays as bundled, and status still counts right', async () => {
    const bytes = new Uint8Array(readFileSync(`${GOLDEN}/basic.gbdemo`));
    const bundled = (await readBundle(bytes)).files.find((f) => f.path === 'repo/.git/index')?.data;
    const fs = new MemFs();
    vi.stubGlobal('crypto', { ...globalThis.crypto, subtle: undefined });
    let repo: DemoRepo;
    try {
      repo = await DemoRepo.load(fs, await readBundle(bytes), noGraph());
    } finally {
      vi.unstubAllGlobals();
    }
    expect(fs.readFileSync('/demo/basic/.git/index')).toEqual(bundled);
    const ws = await repo.worktrees();
    expect([await repo.wipCounts(ws[0]), await repo.wipCounts(ws[1])]).toEqual([
      { ...clean, modified: 1 },
      { ...clean, modified: 1 },
    ]);
  });

  test('status after loading hashes only the files that changed (the index stat data refreshed)', async () => {
    const { fs, repo } = await basic();
    const spy = vi.spyOn(fs.promises, 'readFile');
    const ws = await repo.worktrees();
    expect([await repo.wipCounts(ws[0]), await repo.wipCounts(ws[1])]).toEqual([
      { ...clean, modified: 1 },
      { ...clean, modified: 1 },
    ]);
    const read = spy.mock.calls.map((c) => c[0]).filter((p) => typeof p === 'string' && !p.includes('/.git/') && !p.endsWith('/.git')); // the .git pointer file is worktree resolution, not a hashed file
    expect(read).toEqual(['/demo/basic/file_1.txt', '/demo/.extra/basic/wt-hotfix/file_0.txt']);
  });

  test('refs as the core reads them for the graph', async () => {
    const { repo } = await basic();
    const files = repo.refFiles();
    const refs = await repo.graphRefs(files, repo.refMap(files));
    const find = (n: string) => refs.refs.find((r) => r.fullName === n);
    expect(find('refs/heads/main')).toMatchObject({ shortName: 'main', kind: { type: 'local' }, upstream: 'refs/remotes/origin/main', upstreamMismatch: null });
    expect(find('refs/remotes/origin/feature/login')).toMatchObject({ shortName: 'origin/feature/login', kind: { type: 'remote', remote: 'origin' } });
    expect(find('refs/tags/v1.0')?.annotation?.message).toBe('v1.0');
    expect(refs.remoteHeads).toEqual({ origin: 'refs/remotes/origin/main' });
    expect(refs.remoteHosts).toEqual({ origin: 'generic' });
    expect(refs.remoteHostNames).toEqual({});
    expect(refs.stashes).toHaveLength(1);
    expect(refs.refs.map((r) => r.fullName)).toEqual([...refs.refs.map((r) => r.fullName)].sort());
  });

  test('ancestry counts', async () => {
    const { repo } = await basic();
    const refs = repo.refMap();
    const main = repo.resolveRef(refs, 'refs/heads/main') ?? '';
    const hotfix = repo.resolveRef(refs, 'refs/heads/hotfix') ?? '';
    const feature = repo.resolveRef(refs, 'refs/heads/feature/login') ?? '';
    expect(repo.aheadBehind(main, main)).toEqual([0, 0]);
    expect(repo.aheadBehind(hotfix, main)).toEqual([1, 0]);
    expect(repo.aheadBehind(main, hotfix)).toEqual([0, 1]);
    expect(repo.aheadBehind(feature, main)).toEqual([0, 2]);
  });
});

test('opens a repository built in memory with isomorphic-git (the test kit), exec bits kept', async () => {
  const fs = new MemFs();
  fs.mkdirpSync('/demo/kit');
  await git.init({ fs, dir: '/demo/kit', defaultBranch: 'main' });
  fs.writeFileSync('/demo/kit/run.sh', '#!/bin/sh\n', { mode: 0o755 });
  await git.add({ fs, dir: '/demo/kit', filepath: 'run.sh' });
  const oid = await git.commit({ fs, dir: '/demo/kit', message: 'Add run.sh\n', author: { name: 'Mara Quill', email: 'mara@example.com', timestamp: 1_700_000_000, timezoneOffset: 0 } });
  const repo = await DemoRepo.open(fs, 'kit', noGraph());
  expect([repo.dir, repo.gitdir, [...repo.commits.keys()]]).toEqual(['/demo/kit', '/demo/kit/.git', [oid]]);
  expect(repo.fs).toBe(fs);
  expect(await repo.wipCounts((await repo.worktrees())[0])).toEqual(clean);
  expect((await git.readTree({ fs, dir: '/demo/kit', oid, cache: repo.cache })).tree[0].mode).toBe('100755');
});

test('isClean: any counted change makes a WIP row', () => {
  expect([isClean(clean), isClean({ ...clean, conflicted: 1 }), isClean({ ...clean, renamed: 1 })]).toEqual([true, false, false]);
});

describe('DemoRepos', () => {
  const repos = () => new DemoRepos(goldenManifest(), goldenData(), new MemFs(), noGraph);

  test('opens a repository from any path in one of its worktrees, one id per repository', async () => {
    const r = repos();
    const a = await r.open('/demo/basic');
    expect([a.repo.id, a.worktree]).toEqual([1, '/demo/basic']);
    expect((await r.open('/demo/basic/src/deep/')).repo.id).toBe(1);
    const linked = await r.open('/demo/.extra/basic/wt-hotfix');
    expect([linked.repo.id, linked.worktree]).toEqual([1, '/demo/.extra/basic/wt-hotfix']);
    expect((await r.open('/demo/long_history')).repo.id).toBe(2);
    expect(r.get(2).name).toBe('long_history');
  });

  test('opens a worktree added beside the main one, and a pre-existing one under /demo/.extra', async () => {
    const fs = new MemFs();
    const r = new DemoRepos(goldenManifest(), goldenData(), fs, noGraph);
    const { repo } = await r.open('/demo/basic');
    const link = (path: string, id: string) => {
      fs.mkdirpSync(path);
      fs.mkdirpSync(`${repo.gitdir}/worktrees/${id}`);
      fs.writeFileSync(`${path}/.git`, `gitdir: ${repo.gitdir}/worktrees/${id}\n`);
      fs.writeFileSync(`${repo.gitdir}/worktrees/${id}/gitdir`, `${path}/.git\n`);
      fs.writeFileSync(`${repo.gitdir}/worktrees/${id}/HEAD`, 'ref: refs/heads/main\n');
    };
    link('/demo/basic-x', 'basic-x');
    link('/demo/.extra/basic/wt-release', 'wt-release');
    const found = await r.open('/demo/basic-x/sub');
    expect([found.repo.id, found.worktree]).toEqual([1, '/demo/basic-x']);
    const extra = await r.open('/demo/.extra/basic/wt-release/src');
    expect([extra.repo.id, extra.worktree]).toEqual([1, '/demo/.extra/basic/wt-release']);
  });

  test('loaded: a repository once its bundle is open', async () => {
    const r = repos();
    expect(r.loaded('basic')).toBeUndefined();
    await r.locate('/demo/basic');
    expect(r.loaded('basic')?.dir).toBe('/demo/basic');
    expect(r.loaded('long_history')).toBeUndefined();
  });

  test('fails as the core does', async () => {
    const r = repos();
    await expect(r.open('/demo/nope')).rejects.toMatchObject({ kind: 'NotFound', message: 'Not a git repository: /demo/nope' });
    await expect(r.open('/demo/.extra/basic/elsewhere')).rejects.toMatchObject({ kind: 'NotFound' });
    let thrown: unknown = null;
    try {
      r.get(7);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toMatchObject({ kind: 'InvalidInput', message: 'no open repository with id 7' });
    expect((await r.locate('/demo/basic')).repo.id).toBe(0);
  });
});
