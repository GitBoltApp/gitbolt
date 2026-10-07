import { appendFileSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { freshFixture, git, harnessWs, openUrl } from './fixtures';
import { selectWip } from './wip';
import { expect, test, type Page } from './test';

// How many git processes the app runs while files change (the status-frequency lane): opt-in, it
// takes minutes. `GITBOLT_MEASURE_STATUS=1 npx playwright test --project=chromium
// e2e/status-frequency.spec.ts`; GITBOLT_MEASURE_OUT=<file> also writes the counts as JSON.
const on = !!process.env.GITBOLT_MEASURE_STATUS;
test.skip(!on, 'a measurement: run with GITBOLT_MEASURE_STATUS=1');

type Entry = { id: number; args: string[]; cwd: string };

/** The harness's command log, over a socket of its own. */
async function commandLog(): Promise<Entry[]> {
  const ws = new WebSocket(harnessWs);
  return new Promise((resolve, reject) => {
    ws.onopen = () => ws.send(JSON.stringify({ id: 1, req: { method: 'commandLog' } }));
    ws.onmessage = (e) => {
      const m = JSON.parse(String(e.data)) as { id?: number; ok?: Entry[]; err?: unknown };
      if (m.id !== 1) return;
      ws.close();
      if (m.ok) resolve(m.ok);
      else reject(new Error(JSON.stringify(m.err)));
    };
    ws.onerror = () => reject(new Error('command log socket failed'));
  });
}

/** A command's name: its subcommand, plus the options that tell its kind apart. */
function name(args: string[]): string {
  const a = args[0] === 'git' ? args.slice(1) : args;
  let i = 0;
  while (i < a.length && a[i].startsWith('-')) i += a[i] === '-c' ? 2 : 1;
  const sub = a[i] ?? '?';
  const rest = a.slice(i + 1);
  if (sub === 'diff') return `diff${rest.includes('--numstat') ? ' --numstat' : ''}${rest.includes('--cached') ? ' --cached' : ''}`;
  if (sub === 'worktree' || sub === 'stash' || sub === 'remote') return `${sub} ${rest[0] ?? ''}`;
  return sub;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const SETTLE = 7000;

async function measure(label: string, results: Record<string, Record<string, number>>, act: () => Promise<void>): Promise<void> {
  const before = Math.max(0, ...(await commandLog()).map((e) => e.id));
  await act();
  await sleep(SETTLE);
  const counts: Record<string, number> = {};
  for (const e of await commandLog()) {
    if (e.id <= before) continue;
    let key = name(e.args);
    if (key === 'status' || key.startsWith('diff')) key += e.cwd.includes('/wt-one') ? ' [wt-one]' : e.cwd.includes('/wt-two') ? ' [wt-two]' : '';
    counts[key] = (counts[key] ?? 0) + 1;
  }
  results[label] = counts;
  console.log(`${label}: ${JSON.stringify(counts)}`);
}

const grid = (page: Page) => page.getByRole('grid', { name: 'Commit graph' });

for (const mode of ['wip', 'commit'] as const) {
  test(`git processes while files change, ${mode} selected`, async ({ page }) => {
    test.setTimeout(400_000);
    const repo = freshFixture('worktrees');
    const one = join(dirname(repo), 'wt-one');
    // Build output, ignored in every worktree.
    appendFileSync(join(repo, '.git', 'info', 'exclude'), 'target/\n');
    mkdirSync(join(repo, 'target'), { recursive: true });
    mkdirSync(join(one, 'target'), { recursive: true });
    await page.goto(openUrl(repo));
    await expect(grid(page)).toBeVisible();
    if (mode === 'wip') await selectWip(page);
    else await grid(page).getByRole('row').filter({ hasText: 'main after feature/f5 8' }).first().locator('[data-col="message"]').click();
    await sleep(4000);
    const results: Record<string, Record<string, number>> = {};

    await measure('a single save', results, async () => {
      writeFileSync(join(repo, 'file_1.txt'), 'main change\nsaved\n');
    });
    await measure('b append every 200 ms for 10 s', results, async () => {
      for (let i = 0; i < 50; i++) {
        appendFileSync(join(repo, 'app.log'), `line ${i}\n`);
        await sleep(200);
      }
    });
    await measure('c editor-style save', results, async () => {
      writeFileSync(join(repo, '.file_1.txt.swp'), 'main change\nsaved again\n');
      renameSync(join(repo, '.file_1.txt.swp'), join(repo, 'file_1.txt'));
    });
    await measure('d burst of 50 changes', results, async () => {
      for (let i = 0; i < 50; i++) writeFileSync(join(repo, `burst_${i}.txt`), `${i}\n`);
    });
    await measure('e idle 30 s', results, async () => {
      await sleep(30_000);
    });
    await measure('f ignored build output, 5 s', results, async () => {
      for (let i = 0; i < 25; i++) {
        writeFileSync(join(repo, 'target', `o${i % 5}.o`), `${i}\n`);
        writeFileSync(join(one, 'target', `o${i % 5}.o`), `${i}\n`);
        await sleep(200);
      }
    });
    await measure('g linked worktree busy, 10 s', results, async () => {
      for (let i = 0; i < 33; i++) {
        appendFileSync(join(one, 'file_0.txt'), `edit ${i}\n`);
        writeFileSync(join(one, 'target', `o${i % 5}.o`), `${i}\n`);
        await sleep(300);
      }
    });
    await measure('h fetch (one new remote commit)', results, async () => {
      const other = join(dirname(repo), 'other');
      git(dirname(repo), 'clone', '-q', join(dirname(repo), 'origin.git'), other);
      writeFileSync(join(other, 'fetched.txt'), 'x\n');
      git(other, 'add', 'fetched.txt');
      git(other, 'commit', '-q', '-m', 'Pushed for the measurement');
      git(other, 'push', '-q', 'origin', 'main');
      await page.getByRole('button', { name: 'Fetch', exact: true }).click();
    });

    if (process.env.GITBOLT_MEASURE_OUT) writeFileSync(`${process.env.GITBOLT_MEASURE_OUT}.${mode}.json`, JSON.stringify(results, null, 2));
  });
}
