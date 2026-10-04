import type { APIRequestContext } from '@playwright/test';
import type { Expect } from '../src/api/gen/Expect';
import type { GbError } from '../src/api/gen/GbError';
import type { TestIntent } from '../src/api/gen/TestIntent';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { HARNESS_BIN } from './harness-path';

export const fixtures = JSON.parse(readFileSync(join(import.meta.dirname, '.fixtures.json'), 'utf8')) as {
  basic: string;
  unborn: string;
  longLabels: string;
  wide: string;
  details: string;
  longHistory: string;
  diffView: string;
  mergeLock: string;
  notRepo: string;
};
export const openUrl = (path: string) => `/?repo=${encodeURIComponent(path)}`;
/** The harness's HTTP side (same port rule as playwright.config.ts): `GET /launches` lists the
 * "Open in…" launches it recorded instead of running, `POST /test/reset` (run before every test
 * by `./test`) forgets all state, and `POST /test/emit` puts a JSON `AppEvent` on the bus. */
export const harnessHttp = `http://127.0.0.1:${process.env.GITBOLT_E2E_PORT_BASE ? Number(process.env.GITBOLT_E2E_PORT_BASE) : 7433}`;
/** The harness's WebSocket (what the UI talks to). */
export const harnessWs = `${harnessHttp.replace(/^http/, 'ws')}/ws`;

type FixtureName = 'basic' | 'unborn' | 'long_labels' | 'wide' | 'details' | 'long_history' | 'diff_view' | 'merge_lock' | 'wip_staging' | 'wip_conflict' | 'worktrees' | 'sync' | 'conflicts' | 'stack' | 'rebase60' | 'file_history' | 'irebase' | 'rebase_lab';

/** Written last into a template's folder: the template is complete. Holds the repo's path,
 * relative to the template's folder. */
const TEMPLATE_READY = '.template-ready';

/** The run's one built copy of fixture `name` (`<fixture root>/templates/<name>/<name>`), made by
 * `gitbolt-harness fixture` the first time a test asks for it. */
function template(name: FixtureName): { dir: string; repo: string } {
  const dir = join(fixtures.notRepo, 'templates', name);
  const ready = join(dir, TEMPLATE_READY);
  if (!existsSync(ready)) {
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    const repo = execFileSync(HARNESS_BIN, ['fixture', name, join(dir, name)], { encoding: 'utf8' }).trim();
    writeFileSync(ready, relative(dir, repo));
  }
  return { dir, repo: readFileSync(ready, 'utf8') };
}

/** Rewrites `from` to `to` in a copied fixture's git metadata: the absolute paths git keeps (an
 * origin's URL, a linked worktree's `.git` file and its `gitdir`, FETCH_HEAD). Object stores and
 * indexes are skipped (no absolute paths in them). Returns the work trees (folders with a `.git`). */
function repoint(dir: string, from: string, to: string, workTrees: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    const st = lstatSync(path);
    if (entry === '.git') workTrees.push(dir);
    if (st.isDirectory()) {
      if (entry !== 'objects') repoint(path, from, to, workTrees);
    } else if (st.isFile() && st.size < 65_536 && entry !== 'index') {
      const text = readFileSync(path, 'latin1');
      if (text.includes(from)) writeFileSync(path, text.split(from).join(to), 'latin1');
    }
  }
  return workTrees;
}

/**
 * A brand-new copy of a fixture for one test: tests that change the repo (or its tabs) must not
 * share one. Made under the run's fixture root (`fixtures.notRepo`), which global setup removes.
 * Each fixture is built once per run (its template) and copied from there: `cp -a` (marker
 * included), its absolute paths repointed at the copy, and each work tree's index refreshed (a
 * copy has new inodes and ctimes, so git would see every file as stat-dirty). The same repo as a
 * fresh build, for a fraction of the cost.
 */
export function freshFixture(name: FixtureName): string {
  const { dir, repo } = template(name);
  const root = mkdtempSync(join(fixtures.notRepo, 'fresh-'));
  execFileSync('cp', ['-a', join(dir, name), root]);
  for (const wt of repoint(join(root, name), join(dir, name), join(root, name))) {
    try {
      git(wt, 'update-index', '-q', '--refresh');
    } catch {
      // Exit 1: a file really differs from the index (the fixture's own WIP). Nothing to do.
    }
  }
  return join(root, repo);
}

/** git against fixture repos only, isolated from the developer's config (no signing prompts).
 * GIT_OPTIONAL_LOCKS=0: a test's reads (a `status` polled while the app writes) never take the
 * index lock, which made the app's own write fail ("Repository is locked"). */
export function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'commit.gpgsign=false', ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_OPTIONAL_LOCKS: '0', GIT_AUTHOR_NAME: 'E2E', GIT_AUTHOR_EMAIL: 'e2e@example.com', GIT_COMMITTER_NAME: 'E2E', GIT_COMMITTER_EMAIL: 'e2e@example.com' },
  }).trim();
}

/** `POST /test/write` (spec #2 §18 2A): a test-only write intent on a fixture repo, through the
 * real pipeline. The harness refuses any repo that isn't a marked fixture under its root. */
export async function testWrite(request: APIRequestContext, path: string, intent: TestIntent, extra: { worktree?: string; expect?: Expect } = {}): Promise<{ ok?: unknown; err?: GbError }> {
  const res = await request.post(`${harnessHttp}/test/write`, { data: { path, intent, ...extra } });
  return (await res.json()) as { ok?: unknown; err?: GbError };
}

// --- 2D T17 ---
/** Runs in the sync fixture's origin (`<fixture root>/origin.git`, next to the working copy). */
export const originGit = (repo: string, ...args: string[]): string => git(join(dirname(repo), 'origin.git'), ...args);

/** Writes an executable hook into a fixture repo's hooks dir. */
export function writeHook(repo: string, name: string, script: string): void {
  const path = join(repo, '.git', 'hooks', name);
  writeFileSync(path, script);
  chmodSync(path, 0o755);
}

/** Creates an empty file (a hook's go signal). */
export const touch = (path: string): void => writeFileSync(path, '');
// --- end 2D T17 ---

// --- 4A T14 ---
/** The harness's fake forge (crates/gitbolt-harness/src/fake_forge): GitLab's token for Ada in its
 * default seed (`GITLAB_TOKEN`). Tests reach the fake only through the harness port. */
export const E2E_GITLAB_TOKEN = 'glpat-FAKE-e2e-ada';
export type ForgeSeed = { gitlab: { projects: Array<Record<string, unknown>> } & Record<string, unknown> } & Record<string, unknown>;
/** The fake forge's current seed (reset to the default before every test). */
export async function forgeSeed(request: APIRequestContext): Promise<ForgeSeed> {
  return (await (await request.get(`${harnessHttp}/test/forge/seed`)).json()) as ForgeSeed;
}
export async function setForgeSeed(request: APIRequestContext, seed: ForgeSeed): Promise<void> {
  const res = await request.post(`${harnessHttp}/test/forge/seed`, { data: seed });
  if (!res.ok()) throw new Error(`forge seed refused: ${res.status()}`);
}
// --- end 4A T14 ---

// --- 4B T16 ---
/** The app's own addForgeAccount, through the harness (4A's spec covers the Settings form). */
export async function addForgeAccount(request: APIRequestContext, host: string, kind: 'gitlab' | 'github', token: string): Promise<void> {
  const res = await request.post(`${harnessHttp}/test/forge/account`, { data: { host, kind, token } });
  const body = (await res.json()) as { ok?: unknown; err?: { message: string } };
  if (!res.ok() || body.err) throw new Error(`forge account refused: ${body.err?.message ?? res.status()}`);
}
/** The fake forge's request log (never a token). */
export async function forgeRequests(request: APIRequestContext): Promise<Array<{ forge: string; method: string; path: string; query: string; authorized: boolean }>> {
  return (await (await request.get(`${harnessHttp}/test/forge/requests`)).json()) as Array<{ forge: string; method: string; path: string; query: string; authorized: boolean }>;
}
// --- end 4B T16 ---
