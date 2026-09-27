import { defineConfig, devices } from '@playwright/test';
import { HARNESS_BIN } from './e2e/harness-path';

export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  fullyParallel: false,
  workers: 1,
  globalSetup: './e2e/global-setup.ts',
  use: { baseURL: 'http://localhost:1420', trace: 'retain-on-failure' },
  projects: [
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
    { name: 'chromium', use: { ...devices['Desktop Chrome'], permissions: ['clipboard-read', 'clipboard-write'] } },
  ],
  webServer: [
    { command: `${HARNESS_BIN} serve --port 7433`, url: 'http://127.0.0.1:7433/health', reuseExistingServer: false, timeout: 60_000 },
    { command: 'npm run dev', url: 'http://localhost:1420', reuseExistingServer: false, timeout: 60_000 },
  ],
});
