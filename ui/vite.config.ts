/// <reference types="vitest/config" />
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { demoData } from './build/demoData.ts';
import { licenseNotices } from './build/licenses.ts';
import { replacedGrammars } from './build/replacedGrammars.ts';
import { bundledLanguagesInfo } from './src/diff/shikiLanguages.ts';
import { demoCsp, e2eCsp } from './src/security/csp.ts';

// Parallel `just e2e` runs (one per git worktree) each need their own dev-server port. Unset,
// this stays 1420 exactly as before -- `just dev` and the packaged app both depend on that
// default. Set (by the e2e harness, see playwright.config.ts), Vite takes the base + 1, leaving
// the base port itself for the WebSocket harness.
const portBase = process.env.GITVOLT_E2E_PORT_BASE ? Number(process.env.GITVOLT_E2E_PORT_BASE) : undefined;
const port = portBase !== undefined ? portBase + 1 : 1420;

// The third-party notices (docs/licensing.md): the build writes dist/licenses/ with the UI's own
// notices, and copies in the ones `just licenses` made (target/licenses, or GITVOLT_LICENSES_DIR)
// when they exist, for Help > About GitVolt > Open source licenses.
const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const licensesDir = process.env.GITVOLT_LICENSES_DIR ?? here('../target/licenses');
const notices = licenseNotices({
  root: here('.'),
  aboutToml: here('../about.toml'),
  exceptions: here('build/license-exceptions.json'),
  extraFiles: [
    // .txt: the app's asset protocol serves index.html for a path with no extension.
    { name: 'LICENSE.txt', path: here('../LICENSE') },
    { name: 'THIRD-PARTY-NOTICES-rust.txt', path: `${licensesDir}/THIRD-PARTY-NOTICES-rust.txt` },
    { name: 'CEF-LICENSE.txt', path: `${licensesDir}/CEF-LICENSE.txt` },
    { name: 'DICTIONARY-en-US-LICENSE.txt', path: here('../crates/gitvolt-app/dictionaries/en-US-LICENSE.txt') },
  ],
});
// Shiki grammars replaced by GitVolt's own files (docs/licensing.md): Shiki's grammars that embed
// one (cpp embeds glsl) get GitVolt's file too.
const replaced = Object.keys((JSON.parse(readFileSync(here('build/license-exceptions.json'), 'utf8')) as { replaced?: { grammars?: object } }).replaced?.grammars ?? {});
const grammars = () => replacedGrammars({ root: here('.'), ids: replaced });

// The e2e build runs under the app's Content Security Policy (tauri.conf.json), sent as a header by
// `vite preview --mode e2e` (playwright.config.ts), plus the harness's WebSocket (src/security/csp.ts).
// The dev server has none: Vite's own inline scripts and eval-based HMR need a looser one.
const read = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8');
const previewHeaders = (mode: string): Record<string, string> =>
  mode === 'e2e' ? { 'Content-Security-Policy': e2eCsp(JSON.parse(read('../crates/gitvolt-app/tauri.conf.json')), read('./index.html'), process.env.VITE_GITVOLT_HARNESS ?? 'ws://127.0.0.1:7433/ws') } : {};

// The website demo (`vite build --mode demo`; website demo spec §4.1): demo.html alone, into
// site/dist/demo/ with relative URLs (the site serves it under its own path), its data from
// GITVOLT_DEMO_DATA (relative to the repo root; default site/demo-data/), and the app's Content Security Policy as a <meta>
// (GitHub Pages sends no headers). Every other mode builds as before; the version define is only
// read by the demo's About.
const uiVersion = (JSON.parse(read('./package.json')) as { version: string }).version;
const demoPolicy = (): Plugin => ({
  name: 'gitvolt-demo-csp',
  apply: 'build',
  transformIndexHtml: {
    order: 'post',
    handler: (html) => html.replace('<head>', `<head>\n    <meta http-equiv="Content-Security-Policy" content="${demoCsp(JSON.parse(read('../crates/gitvolt-app/tauri.conf.json')), html)}" />`),
  },
});

export default defineConfig(({ mode }) => {
  const demo = mode === 'demo';
  return {
    base: demo ? './' : '/',
    plugins: [react(), grammars(), notices.main, ...(demo ? [demoPolicy(), demoData(process.env.GITVOLT_DEMO_DATA ? resolve(here('..'), process.env.GITVOLT_DEMO_DATA) : here('../site/demo-data'), here('src/demo/wasm/THIRD-PARTY-NOTICES-wasm.txt'))] : [])],
    define: { 'import.meta.env.VITE_GITVOLT_VERSION': JSON.stringify(uiVersion) },
    worker: { plugins: () => [grammars(), notices.worker()] },
    clearScreen: false,
    server: { port, strictPort: true },
    preview: { headers: previewHeaders(mode) },
    build: demo ? { target: 'es2023', outDir: here('../site/dist/demo'), emptyOutDir: true, rolldownOptions: { input: here('demo.html') } } : { target: 'es2023' },
    resolve: {
      alias: [
        // micromark's entity decoder: its `browser` build decodes through `document`, which the
        // Markdown parse worker (markdown/parse.worker.ts) doesn't have, so the worker died on
        // load and every large body was parsed on the main thread. The plain build (a lookup table)
        // works in both.
        { find: /^decode-named-character-reference$/, replacement: fileURLToPath(new URL('./node_modules/decode-named-character-reference/index.js', import.meta.url)) },
        // The website demo's WebAssembly graph: the glue `just demo-wasm` writes (git-ignored),
        // typed by src/demo/gitvolt-graph-wasm.d.ts. Only the demo imports it.
        { find: /^gitvolt-graph-wasm$/, replacement: fileURLToPath(new URL('./src/demo/wasm/gitvolt_graph_wasm.js', import.meta.url)) },
      ],
    },
    // Monaco and Shiki are only reached through a dynamic import (diff/monaco/load.ts). Pre-bundle
    // them at dev-server start, so the first diff doesn't trigger a re-optimize and page reload in
    // the middle of a Playwright test.
    optimizeDeps: {
      include: [
        'monaco-editor/editor/editor.api',
        'monaco-editor/features/register.all',
        'shiki/core',
        'shiki/engine/oniguruma',
        // Each grammar by name, from GitVolt's registry rather than Shiki's (docs/licensing.md).
        ...bundledLanguagesInfo.filter((l) => !replaced.includes(l.id)).map((l) => `shiki/langs/${l.id}.mjs`),
        'shiki/themes/*.mjs', // the dev server's cache only: the build bundles just the themes editorThemes.ts names
        'shiki/wasm',
        '@shikijs/monaco',
        // Markdown (5A): reached through the lazy renderer chunk
        'unified',
        'remark-parse',
        'remark-gfm',
        'remark-rehype',
        'rehype-raw',
        'rehype-sanitize',
        'hast-util-to-jsx-runtime',
        'github-slugger',
        'mermaid',
      ],
    },
    test: {
      setupFiles: ['src/test-setup.ts'],
      // Components in happy-dom; logic in plain Node, which starts in a fraction of the time (a
      // jsdom environment per file was most of the suite's run, and happy-dom runs the components in
      // about half jsdom's time). A test that needs another says so on its first line: a .ts one
      // that needs a DOM `// @vitest-environment happy-dom`, one that needs what only jsdom does
      // `// @vitest-environment jsdom`.
      projects: [
        { extends: true, test: { name: 'dom', environment: 'happy-dom', include: ['src/**/*.test.tsx'] } },
        { extends: true, test: { name: 'logic', environment: 'node', include: ['src/**/*.test.ts', 'build/**/*.test.ts'] } },
      ],
      // The dev machine is power-capped and often runs several builds at once: a loaded run took
      // 5-9 s for tests that finish in under 1 s idle. 15 s keeps real hangs failing.
      testTimeout: 15_000,
      // Child processes, one per worker (vitest's default, written out). `threads` was no faster
      // here, and under the lanes' `ulimit -v` cap its workers, which share one address space, ran
      // out of virtual memory (V8 code ranges, Shiki's Wasm). The default worker count (cores - 1)
      // was as fast as 8 workers; 4 took about half as long again.
      pool: 'forks',
    },
  };
});
