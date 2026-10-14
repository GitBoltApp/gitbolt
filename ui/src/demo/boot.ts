// Starts the demo's backend: the manifest and the WebAssembly graph, fetched from the page's own
// folder (no other origin), then the runtime over them.
import { loadGraphWasm } from './engine/graph';
import { createRuntime, httpData } from './runtime';
import type { DemoRuntime } from './transport';

export async function bootDemo(): Promise<DemoRuntime> {
  // The build's rev of its data (ui/build/demoDataRev.ts); none on the dev server.
  const rev = (import.meta.env.VITE_GITVOLT_DEMO_DATA_REV as string | undefined) ?? '';
  const data = httpData(new URL('demo-data/', document.baseURI), rev);
  const [manifest, graph] = await Promise.all([data.manifest(), loadGraphWasm()]);
  return createRuntime({ manifest, data, graph, width: window.innerWidth });
}
