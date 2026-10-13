import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import { GOLDEN, noGraph } from '../testing';
import { readBundle } from './bundle';
import { MemFs } from './memfs';
import { DemoRepo } from './repo';
import { buildSidebar, pushTarget } from './sidebar';

test("the basic fixture's sidebar", async () => {
  const repo = await DemoRepo.load(new MemFs(), await readBundle(new Uint8Array(readFileSync(`${GOLDEN}/basic.gbdemo`))), noGraph());
  const s = await buildSidebar(repo);
  expect(s.locals.map((b) => b.name)).toEqual(['feature/login', 'hotfix', 'main']);
  const main = s.locals.find((b) => b.name === 'main');
  expect(main).toMatchObject({ fullName: 'refs/heads/main', upstream: 'refs/remotes/origin/main', ahead: 0, behind: 0, gone: false, isHead: true, worktree: null, checkedOut: '/demo/basic', pushTarget: 'origin/main', pushBehind: 0, rewritten: null });
  expect(main !== undefined && 'upstreamMismatch' in main).toBe(false);
  expect(s.locals.find((b) => b.name === 'hotfix')).toMatchObject({ upstream: null, isHead: false, worktree: '/demo/.extra/basic/wt-hotfix', pushTarget: null, pushBehind: null });
  expect(s.remotes).toHaveLength(1);
  expect(s.remotes[0]).toMatchObject({ name: 'origin', host: null, hostKind: 'generic', defaultBranch: 'refs/remotes/origin/main' });
  expect(s.remotes[0].branches.map((b) => b.name)).toEqual(['feature/login', 'main']);
  expect(s.tags.map((t) => [t.name, t.annotation?.message])).toEqual([['v1.0', 'v1.0']]);
  expect(s.worktrees.map((w) => [w.name, w.branch, w.isMain, w.isCurrent])).toEqual([['basic', 'main', true, true], ['wt-hotfix', 'hotfix', false, false]]);
  expect(s.stashes.map((x) => [x.index, x.message])).toEqual([[0, 'On main: Experiment']]);
  expect(await pushTarget(repo, 'main')).toEqual({ remote: 'origin', branch: 'main' });
  expect(await pushTarget(repo, 'hotfix')).toBeNull();
});

const sorted = (v: unknown): unknown =>
  Array.isArray(v) ? v.map(sorted) : v !== null && typeof v === 'object' ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, x]) => [k, sorted(x)])) : v;

test.each([['basic', 6], ['long_history', 3]])("%s's sidebar matches the core's golden", async (fx, n) => {
  const repo = await DemoRepo.load(new MemFs(), await readBundle(new Uint8Array(readFileSync(`${GOLDEN}/${fx}.gbdemo`))), noGraph());
  const { response } = JSON.parse(readFileSync(`${GOLDEN}/${fx}/${n}.json`, 'utf8')) as { response: unknown };
  const want = JSON.stringify(response).replaceAll('$repo', repo.name).replaceAll(/\$wt:([^"/]+)/g, `/demo/.extra/${fx}/$1`).replaceAll('$wt', `/demo/${fx}`);
  expect(sorted(JSON.parse(JSON.stringify(await buildSidebar(repo))))).toEqual(sorted(JSON.parse(want)));
});
