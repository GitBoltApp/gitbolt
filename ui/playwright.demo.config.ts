import { defineConfig, devices } from '@playwright/test';

// The website demo's smoke test (`just e2e-demo`): a demo build (e2e-demo/build-demo.mjs, over the
// parity suite's fixtures), served as static files as GitHub Pages serves it. A config of its own:
// the main one starts the harness and the app's e2e build for every run. Its port is the e2e port
// base + 2 (the harness has the base, the app's UI base + 1), 1422 by default.
const portBase = process.env.GITVOLT_E2E_PORT_BASE ? Number(process.env.GITVOLT_E2E_PORT_BASE) : undefined;
const port = portBase !== undefined ? portBase + 2 : 1422;

export default defineConfig({
  testDir: './e2e-demo',
  timeout: 30_000,
  fullyParallel: false,
  workers: 1,
  use: { baseURL: `http://localhost:${port}`, trace: process.env.GITVOLT_E2E_TRACE ? 'retain-on-failure' : 'off', screenshot: 'only-on-failure' },
  // 1,000 px wide: above the demo's 960 px minimum, under 1,280 px, so the narrow start is tested.
  projects: [{ name: 'demo', use: { ...devices['Desktop Chrome'], viewport: { width: 1000, height: 760 } } }],
  webServer: {
    command: `node e2e-demo/build-demo.mjs && npx vite preview --mode demo --outDir dist-demo-e2e --port ${port} --strictPort`,
    url: `http://localhost:${port}/demo.html`,
    reuseExistingServer: false,
    timeout: 240_000,
  },
});
