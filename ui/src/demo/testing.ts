// Test helpers for the demo's vitest suites: the parity suite's folder (also a demo data folder)
// and a stand-in for the WebAssembly graph. Never imported by the app.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { GraphFactory } from './engine/layout';
import type { DemoData, Manifest } from './engine/repos';

export const GOLDEN = fileURLToPath(new URL('./golden', import.meta.url));
export const WASM_GZ = fileURLToPath(new URL('./wasm/gitvolt_graph_wasm_bg.wasm.gz', import.meta.url));

export const goldenManifest = (dir = GOLDEN): Manifest => JSON.parse(readFileSync(`${dir}/manifest.json`, 'utf8')) as Manifest;

export function goldenData(dir = GOLDEN): DemoData {
  return { manifest: async () => goldenManifest(dir), bundle: async (file) => new Uint8Array(readFileSync(`${dir}/${file}`)) };
}

/** For tests that never build a graph: `just demo-wasm` isn't needed for them. */
export const noGraph: GraphFactory = () => ({
  addCommits: (commits) => commits.length,
  build: () => {
    throw new Error('this test has no WebAssembly graph');
  },
  walkOrder: () => {
    throw new Error('this test has no WebAssembly graph');
  },
});
