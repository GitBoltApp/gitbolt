/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Parallel `just e2e` runs (one per git worktree) each need their own dev-server port. Unset,
// this stays 1420 exactly as before -- `just dev` and the packaged app both depend on that
// default. Set (by the e2e harness, see playwright.config.ts), Vite takes the base + 1, leaving
// the base port itself for the WebSocket harness.
const portBase = process.env.GITBOLT_E2E_PORT_BASE ? Number(process.env.GITBOLT_E2E_PORT_BASE) : undefined;
const port = portBase !== undefined ? portBase + 1 : 1420;

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: { port, strictPort: true },
  build: { target: 'es2023' },
  // Monaco and Shiki are only reached through a dynamic import (diff/monaco/load.ts). Pre-bundle
  // them at dev-server start, so the first diff doesn't trigger a re-optimize and page reload in
  // the middle of a Playwright test.
  optimizeDeps: {
    include: [
      'monaco-editor/editor/editor.api',
      'monaco-editor/features/register.all',
      'shiki/core',
      'shiki/engine/oniguruma',
      'shiki/langs',
      'shiki/themes',
      'shiki/wasm',
      '@shikijs/monaco',
    ],
  },
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.{ts,tsx}'],
    setupFiles: ['src/test-setup.ts'],
    // The dev machine is power-capped and often runs several builds at once: a loaded run took
    // 5-9 s for tests that finish in under 1 s idle. 15 s keeps real hangs failing.
    testTimeout: 15_000,
    // Child processes, one per worker (vitest's default, written out). `threads` was no faster
    // here, and under the lanes' `ulimit -v` cap its workers, which share one address space, ran
    // out of virtual memory (V8 code ranges, Shiki's Wasm). The default worker count (cores - 1)
    // was as fast as 8 workers; 4 took about half as long again.
    pool: 'forks',
  },
});
