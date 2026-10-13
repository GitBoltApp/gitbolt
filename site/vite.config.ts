/// <reference types="vitest/config" />
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import { keepDemo } from './build/clean.ts';
import { demoDev } from './build/demo-dev.ts';
import { sitePolicy } from './build/csp.ts';
import { fonts } from './build/fonts.ts';
import { page } from './build/page.ts';
import { readmeMarker } from './build/readme.ts';
import { releaseMarker } from './build/release.ts';
import { heroMarker } from './build/shots.ts';

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));

// The website (spec §6): one static page, relative URLs (served under /gitbolt/), no asset inlined
// as a data: URI (the CSP allows none), and dist/demo/ left to the demo's own build. The page's
// generated parts come from README.md, data/release.json and shots/ (build/page.ts).
export default defineConfig({
  base: './',
  plugins: [
    keepDemo(),
    demoDev(here('dist/demo')),
    page({
      readme: readmeMarker(here('../README.md'), here('shots')),
      release: releaseMarker(here('data/release.json')),
      hero: heroMarker(here('shots')),
    }),
    fonts(here('.'), here('../about.toml')),
    sitePolicy(),
  ],
  server: { port: 1430 },
  build: { target: 'es2023', outDir: 'dist', emptyOutDir: false, assetsInlineLimit: 0, modulePreload: { polyfill: false } },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'build/**/*.test.ts', 'scripts/**/*.test.ts'],
    testTimeout: 15_000,
    pool: 'forks',
  },
});
