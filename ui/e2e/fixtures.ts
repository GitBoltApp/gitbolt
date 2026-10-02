import type { APIRequestContext } from '@playwright/test';
import type { Expect } from '../src/api/gen/Expect';
import type { GbError } from '../src/api/gen/GbError';
import type { TestIntent } from '../src/api/gen/TestIntent';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
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

/**
 * A brand-new copy of a fixture for one test: tests that change the repo (or its tabs) must not
 * share one. Made under the run's fixture root (`fixtures.notRepo`), which global setup removes.
 */
export function freshFixture(name: 'basic' | 'unborn' | 'long_labels' | 'wide' | 'details' | 'long_history' | 'diff_view' | 'merge_lock' | 'wip_staging' | 'wip_conflict' | 'worktrees' | 'sync' | 'conflicts' | 'stack' | 'rebase60'): string {
  const root = mkdtempSync(join(fixtures.notRepo, 'fresh-'));
  return execFileSync(HARNESS_BIN, ['fixture', name, join(root, name)], { encoding: 'utf8' }).trim();
}

/** git against fixture repos only, isolated from the developer's config (no signing prompts). */
export function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'commit.gpgsign=false', ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'E2E', GIT_AUTHOR_EMAIL: 'e2e@example.com', GIT_COMMITTER_NAME: 'E2E', GIT_COMMITTER_EMAIL: 'e2e@example.com' },
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
