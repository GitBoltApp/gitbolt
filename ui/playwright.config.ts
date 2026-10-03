import { defineConfig, devices } from '@playwright/test';
import { HARNESS_BIN } from './e2e/harness-path';

// GITBOLT_E2E_PORT_BASE lets several `just e2e` runs (one per git worktree) coexist without
// colliding on fixed ports. Unset: harness on 7433, the UI on 1420. Set to N: harness on N, the UI
// on N+1 (vite.config.ts derives the same N+1 from this env var for the dev server). The UI learns
// its harness port from VITE_GITBOLT_HARNESS, set below only on the UI server's process: baked
// into the e2e build, read at runtime by the dev server (src/api/transport.ts).
const portBase = process.env.GITBOLT_E2E_PORT_BASE ? Number(process.env.GITBOLT_E2E_PORT_BASE) : undefined;
const harnessPort = portBase ?? 7433;
const vitePort = portBase !== undefined ? portBase + 1 : 1420;
const harnessWs = `ws://127.0.0.1:${harnessPort}/ws`;

// The UI under test: by default a production bundle (`vite build --mode e2e` into dist-e2e, redone
// only when its inputs change: e2e/build-ui.mjs), served as static files by `vite preview`. A page
// then loads a few minified chunks instead of the dev server's hundreds of unbundled modules
// (Monaco above all): that was most of what a test cost. The `e2e` mode keeps the test hooks
// (`window.__gb`) the release bundle compiles out. GITBOLT_E2E_DEV=1 serves the Vite dev server
// instead (source, unminified React errors), for debugging a spec.
const devServer = !!process.env.GITBOLT_E2E_DEV;
const uiServer = devServer
  ? { command: 'npm run dev', timeout: 60_000 }
  : {
      command: `node e2e/build-ui.mjs && npx vite preview --mode e2e --outDir dist-e2e --port ${vitePort} --strictPort`,
      timeout: 180_000,
    };

// Traces are off by default: recording one for every test (to keep the failures') took about
// half of the suite's CPU time, DOM snapshots above all. A failure still leaves a screenshot.
// GITBOLT_E2E_TRACE=1 records them and keeps each failure's (`npx playwright show-trace …`):
// rerun the failing spec with it.
const trace = process.env.GITBOLT_E2E_TRACE ? 'retain-on-failure' : 'off';

const chromium = { ...devices['Desktop Chrome'], permissions: ['clipboard-read', 'clipboard-write'] };

export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  fullyParallel: false,
  workers: 1,
  globalSetup: './e2e/global-setup.ts',
  use: { baseURL: `http://localhost:${vitePort}`, trace, screenshot: 'only-on-failure' },
  projects: [
    // Chromium first: it's what the CEF runtime embeds (Task 14), so this is the primary target.
    // Its timing budgets (tests tagged @budget: "< 100 ms, best of 3", the menu and tab-switch
    // latencies) are a project of their own, run after the rest, so a loaded run doesn't trip
    // them. Same browser, same budgets.
    { name: 'chromium', grepInvert: /@budget/, use: chromium },
    { name: 'chromium-budget', grep: /@budget/, use: chromium },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
  ],
  webServer: [
    { command: `${HARNESS_BIN} serve --port ${harnessPort}`, url: `http://127.0.0.1:${harnessPort}/health`, reuseExistingServer: false, timeout: 60_000 },
    {
      ...uiServer,
      url: `http://localhost:${vitePort}`,
      reuseExistingServer: false,
      // Read at build time (and by the dev server): the UI's WebSocket URL (src/api/transport.ts).
      env: { VITE_GITBOLT_HARNESS: harnessWs },
    },
  ],
});
