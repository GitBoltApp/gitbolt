import { defineConfig, devices } from '@playwright/test';
import { HARNESS_BIN } from './e2e/harness-path';

// GITBOLT_E2E_PORT_BASE lets several `just e2e` runs (one per git worktree) coexist without
// colliding on fixed ports. Unset, behavior is unchanged: harness on 7433, Vite on 1420. Set to
// N: harness on N, Vite on N+1 (vite.config.ts derives the same N+1 from this env var). The Vite
// dev server learns its harness port at runtime via VITE_GITBOLT_HARNESS, set below only on the
// spawned `npm run dev` process -- the UI already reads that var for its WebSocket URL
// (src/api/transport.ts), so no new UI wiring is needed.
const portBase = process.env.GITBOLT_E2E_PORT_BASE ? Number(process.env.GITBOLT_E2E_PORT_BASE) : undefined;
const harnessPort = portBase ?? 7433;
const vitePort = portBase !== undefined ? portBase + 1 : 1420;

export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  fullyParallel: false,
  workers: 1,
  globalSetup: './e2e/global-setup.ts',
  use: { baseURL: `http://localhost:${vitePort}`, trace: 'retain-on-failure' },
  projects: [
    // Chromium first: it's what the CEF runtime embeds (Task 14), so this is the primary target.
    { name: 'chromium', use: { ...devices['Desktop Chrome'], permissions: ['clipboard-read', 'clipboard-write'] } },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
  ],
  webServer: [
    { command: `${HARNESS_BIN} serve --port ${harnessPort}`, url: `http://127.0.0.1:${harnessPort}/health`, reuseExistingServer: false, timeout: 60_000 },
    {
      command: 'npm run dev',
      url: `http://localhost:${vitePort}`,
      reuseExistingServer: false,
      timeout: 60_000,
      env: { VITE_GITBOLT_HARNESS: `ws://127.0.0.1:${harnessPort}/ws` },
    },
  ],
});
