// The graph pipeline compiled from crates/gitvolt-graph (gitvolt-graph-wasm): loaded once, one
// engine (a commit store) per repository. JSON in and out, the payload as the core's.
import init, { GraphEngine } from 'gitvolt-graph-wasm';
import { gunzipIfNeeded } from './bundle';
import { gbError } from './errors';
import type { GraphFactory } from './layout';

// Gzipped at build time: GitHub Pages doesn't compress .wasm (spec §5.3).
const WASM_URL = new URL('../wasm/gitvolt_graph_wasm_bg.wasm.gz', import.meta.url);

/** `bytes`: the .wasm (tests read it from disk); fetched next to this module otherwise. */
export async function loadGraphWasm(bytes?: Uint8Array): Promise<GraphFactory> {
  let raw = bytes;
  if (!raw) {
    const res = await fetch(WASM_URL);
    if (!res.ok) throw gbError('NotFound', `The demo's graph module is missing (${res.status})`);
    raw = new Uint8Array(await res.arrayBuffer());
  }
  await init({ module_or_path: await gunzipIfNeeded(raw) });
  return () => {
    const engine = new GraphEngine();
    return {
      addCommits: (commits) => engine.addCommits(JSON.stringify(commits)),
      build: (request) => JSON.parse(engine.build(JSON.stringify(request))),
      walkOrder: (request) => JSON.parse(engine.walkOrder(JSON.stringify(request))) as string[],
    };
  };
}
