import { defineConfig, devices } from '@playwright/test';

// The site's screenshots (`just site-shots`, on demand, never in CI): headless Chromium at device
// scale 2 on the demo build (dist/demo/), served as static files. Port: the e2e port base + 4
// (1424 by default).
const port = (process.env.GITBOLT_E2E_PORT_BASE ? Number(process.env.GITBOLT_E2E_PORT_BASE) : 1420) + 4;

export default defineConfig({
  testDir: './e2e-shots',
  timeout: 120_000,
  workers: 1,
  fullyParallel: false,
  use: {
    ...devices['Desktop Chrome'],
    headless: true,
    deviceScaleFactor: 2,
    baseURL: `http://localhost:${port}/`,
    timezoneId: 'UTC',
    locale: 'en-US',
    colorScheme: 'dark',
    trace: 'off',
    screenshot: 'off',
  },
  webServer: {
    command: `npx vite preview --outDir dist --port ${port} --strictPort`,
    url: `http://localhost:${port}/demo/demo.html`,
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
