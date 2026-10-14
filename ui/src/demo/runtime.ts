// The demo backend's state: its repositories, settings and event bus, over its data.
import type { DemoClock, DemoContext } from './context';
import { systemClock } from './engine/clock';
import { gbError, notInDemo } from './engine/errors';
import { createEventBus } from './engine/events';
import type { GraphFactory } from './engine/layout';
import { MemFs } from './engine/memfs';
import { netOf } from './engine/remote/network';
import { type DemoData, DemoRepos, type Manifest } from './engine/repos';
import { initialState } from './engine/state';
import { DemoWrites } from './engine/write/state';
import type { DemoRuntime } from './transport';

export interface RuntimeOptions {
  manifest: Manifest;
  data: DemoData;
  graph: GraphFactory;
  /** The frame's width at load (the panels' first widths); wide when absent. */
  width?: number;
  /** The demo's time; the browser's when absent. */
  clock?: DemoClock;
}

export function createRuntime(o: RuntimeOptions): DemoRuntime {
  const bus = createEventBus();
  const fs = new MemFs();
  const ctx: DemoContext = {
    repos: new DemoRepos(o.manifest, o.data, fs, o.graph),
    state: initialState(o.manifest, o.width ?? Number.POSITIVE_INFINITY),
    emit: (ev) => bus.emit(ev),
    notInDemo,
    clock: o.clock ?? systemClock,
    writes: new DemoWrites(),
  };
  netOf(ctx).fs = fs;
  return { ctx, bus };
}

/** The manifest and bundles under `base` (the page's `demo-data/`): its own origin only. The
 * build's `rev` goes on the manifest's URL and each bundle's on the bundle's (`?v=`), so a page
 * never gets a copy cached from an older deploy (docs/website.md). */
export function httpData(base: URL, rev = ''): DemoData {
  const get = async (file: string, v?: string): Promise<Uint8Array> => {
    const url = new URL(file, base);
    if (v) url.searchParams.set('v', v);
    const res = await fetch(url);
    if (!res.ok) throw gbError('NotFound', `The demo's data is missing: ${file} (${res.status})`);
    return new Uint8Array(await res.arrayBuffer());
  };
  return {
    manifest: async () => JSON.parse(new TextDecoder().decode(await get('manifest.json', rev))) as Manifest,
    bundle: (file, v) => get(file, v),
  };
}
