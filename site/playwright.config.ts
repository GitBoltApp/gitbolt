import { defineConfig, devices } from '@playwright/test';

// The website's checks (`just e2e-site`): the built site (dist/, the demo included), served as
// static files as GitHub Pages serves them. Port: the e2e port base + 3 (1423 by default).
const port = (process.env.GITVOLT_E2E_PORT_BASE ? Number(process.env.GITVOLT_E2E_PORT_BASE) : 1420) + 3;

export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  workers: 1,
  fullyParallel: false,
  use: { baseURL: `http://localhost:${port}/`, trace: process.env.GITVOLT_E2E_TRACE ? 'retain-on-failure' : 'off', screenshot: 'only-on-failure' },
  projects: [{ name: 'site', use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 860 } } }],
  webServer: {
    command: `npx vite preview --outDir dist --base / --port ${port} --strictPort`,
    url: `http://localhost:${port}/`,
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
