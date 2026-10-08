// Drives a running debug build of the app over the DevTools protocol (`GITBOLT_DEV_CDP_PORT`):
// the commit graph, a commit, its diff and a fetch, in the `basic` fixture the app was launched
// on; then, given a second fixture (`sync`), a second launch of the app on it, which must hand its
// path to the first instance and exit; then, on macOS, given the app's bundle and a third fixture
// (`stack`), `open -a <bundle> <third repo>`, which macOS hands to the running app as an Apple
// Event (not an argument): it must open in a new tab too. A page screenshot after each step goes
// to <out dir>.
//
//   node ui/scripts/cdp-smoke.mjs <cdp port> <out dir> <repo> [<app executable> <second repo> [<app bundle> <third repo>]]
//
// The second launch inherits this process's environment (GITBOLT_DEV_DIRS, TMPDIR), which keys
// the single-instance socket. Exits 1 on the first failed step, after a screenshot of it.
import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { chromium } from '@playwright/test';

const [port, outDir, repo, appExe, secondRepo, appBundle, thirdRepo] = process.argv.slice(2);
if (!port || !outDir || !repo) {
  console.error('usage: cdp-smoke.mjs <cdp port> <out dir> <repo> [<app executable> <second repo> [<app bundle> <third repo>]]');
  process.exit(2);
}
mkdirSync(outDir, { recursive: true });

const results = [];
let shot = 0;

/** Runs `file args`; rejects with its stderr on a non-zero exit. */
function run(file, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: 60_000, ...options }, (error, stdout, stderr) =>
      error ? reject(new Error(`${file} ${args.join(' ')} failed (${error.code ?? error.signal}): ${stderr.slice(-500)}`)) : resolve(stdout));
  });
}

/** A fictional author for the commit pushed from elsewhere (the runner has no git identity). */
const AUTHOR = { GIT_AUTHOR_NAME: 'Smoke Test', GIT_AUTHOR_EMAIL: 'smoke@example.com', GIT_COMMITTER_NAME: 'Smoke Test', GIT_COMMITTER_EMAIL: 'smoke@example.com' };

/** Pushes branch `from-smoke` with one commit to the fixture's origin, from another clone. */
async function pushFromElsewhere(message) {
  const other = join(mkdtempSync(join(tmpdir(), 'gb-smoke-')), 'other');
  const git = (...args) => run('git', args, { cwd: other, env: { ...process.env, ...AUTHOR } });
  await run('git', ['clone', '-q', join(dirname(repo), 'origin.git'), other]);
  await git('switch', '-q', '-c', 'from-smoke');
  writeFileSync(join(other, 'smoke.txt'), 'x\n');
  await git('add', 'smoke.txt');
  await git('commit', '-q', '-m', message);
  await git('push', '-q', 'origin', 'from-smoke');
}

async function connect(deadline) {
  for (;;) {
    try {
      return await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    } catch (e) {
      if (Date.now() > deadline) throw e;
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
}

/** The app's own page: the first one that isn't DevTools. */
async function appPage(browser, deadline) {
  for (;;) {
    const page = browser.contexts().flatMap((c) => c.pages()).find((p) => !p.url().startsWith('devtools:'));
    if (page) return page;
    if (Date.now() > deadline) throw new Error('no app page');
    await new Promise((r) => setTimeout(r, 500));
  }
}

async function step(page, name, body) {
  const started = Date.now();
  try {
    await body();
    results.push({ step: name, ok: true, ms: Date.now() - started });
  } catch (e) {
    results.push({ step: name, ok: false, ms: Date.now() - started, error: String(e?.message ?? e).split('\n')[0] });
  } finally {
    shot += 1;
    await page.screenshot({ path: join(outDir, `${String(shot).padStart(2, '0')}-${name}.png`) }).catch(() => {});
  }
  if (!results.at(-1).ok) finish(1);
}

function finish(code) {
  writeFileSync(join(outDir, 'results.json'), JSON.stringify(results, null, 2));
  for (const r of results) console.log(`${r.ok ? 'ok  ' : 'FAIL'} ${r.step} (${r.ms} ms)${r.error ? `: ${r.error}` : ''}`);
  process.exit(code);
}

const browser = await connect(Date.now() + 120_000);
const page = await appPage(browser, Date.now() + 60_000);
console.log(`app page: ${page.url()}`);
const graph = page.getByRole('grid', { name: 'Commit graph' });
const row = (text) => page.getByRole('row').filter({ hasText: text });

await step(page, 'graph', async () => {
  await graph.waitFor({ timeout: 60_000 });
  await row('Login validation').first().waitFor({ timeout: 30_000 });
});

await step(page, 'commit', async () => {
  await row('Add readme').first().click();
  await page.getByTestId('file-counts').waitFor({ timeout: 30_000 });
});

await step(page, 'diff', async () => {
  await page.getByRole('option').and(page.locator('[data-path]')).first().click();
  await page.getByRole('region', { name: 'Diff' }).getByTestId('diff-path').waitFor({ timeout: 30_000 });
  // Monaco paints its lines a moment after the panel shows.
  await page.locator('.diff-body').first().waitFor({ timeout: 30_000 });
  await page.waitForTimeout(1000);
});

await step(page, 'fetch', async () => {
  // Back to the graph, which the diff covers.
  await page.getByRole('button', { name: 'Close diff' }).click();
  await graph.waitFor({ timeout: 10_000 });
  await pushFromElsewhere('Pushed from elsewhere');
  if (await page.getByText('Pushed from elsewhere').count()) throw new Error('the new commit shows before the fetch');
  await page.getByRole('button', { name: 'Fetch', exact: true }).click();
  await row('Pushed from elsewhere').getByText('from-smoke').waitFor({ timeout: 60_000 });
});

if (appExe && secondRepo) {
  await step(page, 'second-launch', async () => {
    const tabs = page.getByRole('tablist', { name: 'Repositories' }).getByRole('tab');
    const before = await tabs.count();
    // It exits 0 once the first instance has its path.
    await run(appExe, [secondRepo]);
    // The first instance opened it: a new tab, showing the `sync` fixture's history.
    await row('Remote side').first().waitFor({ timeout: 30_000 });
    const after = await tabs.count();
    if (after !== before + 1) throw new Error(`${before} tab(s) before the second launch, ${after} after`);
  });
}

if (appBundle && thirdRepo) {
  await step(page, 'open-a', async () => {
    const tabs = page.getByRole('tablist', { name: 'Repositories' }).getByRole('tab');
    const before = await tabs.count();
    await run('open', ['-a', appBundle, thirdRepo]);
    // The `stack` fixture's history, in a new tab.
    await row('Main moves').first().waitFor({ timeout: 30_000 });
    const after = await tabs.count();
    if (after !== before + 1) throw new Error(`${before} tab(s) before open -a, ${after} after`);
  });
}

finish(0);
