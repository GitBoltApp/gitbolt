/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: { port: 1420, strictPort: true },
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
  },
});
