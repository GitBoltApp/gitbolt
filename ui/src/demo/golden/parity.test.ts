// The demo backend against the real core (website demo spec §4.4): each fixture's bundle answers
// the requests recorded in golden/<fixture>/, and each answer must be the one the harness gave on
// the same fixture (`just demo-golden`). A `<fixture>@<scenario>` is a write scenario: its answers
// come with the events each request emitted, and the demo runs at the parity instant. Skipped
// until `just demo-wasm` has built the graph.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { describe, expect, test } from 'vitest';
import type { Request } from '../../api/gen/Request';
import { fixedClock, PARITY_MS } from '../engine/clock';
import { demoRoot } from '../engine/paths';
import { netOf } from '../engine/remote/network';
import { forgeOf } from '../forge/hub';
import { HANDLERS } from '../handlers';
import { createRuntime } from '../runtime';
import { GOLDEN, goldenData, WASM_GZ } from '../testing';
import { createDemoTransport } from '../transport';
import { makeEventNormaliser, normaliseError, normaliseResponse, refusedBy, unreachable, unreachableEvents } from './normalise';

/** The harness fake forge's time for every write (`fake_forge::gitlab_mrs::WRITE_TIME`). */
const FAKE_WRITE_TIME = '2026-10-04T12:30:00Z';

// Not compared by design: forgeImage and forgeVideo (the core fetches the forge over HTTP, the demo
// serves the bundle's uploads), forgeCreateMr and forgeCompleteCreate (the created MR's iid: the
// harness fake counts only MRs created through it, the demo one past the project's highest).

const stems = readdirSync(`${GOLDEN}/requests`).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5));

/** A recorded request as the demo receives it: `"$repo"`, `"$wt"` and `"$wt:<dir>"` filled in. */
function substitute(v: unknown, name: string, id: number | null): unknown {
  if (v === '$repo') return id;
  if (v === '$wt') return demoRoot(name, 'repo');
  if (typeof v === 'string' && v.startsWith('$wt:')) return demoRoot(name, v.slice('$wt:'.length));
  if (Array.isArray(v)) return v.map((x) => substitute(x, name, id));
  if (v !== null && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, substitute(x, name, id)]));
  return v;
}

describe.skipIf(!existsSync(WASM_GZ))('the demo answers as the core does (needs `just demo-wasm`)', () => {
  for (const stem of stems) {
    const name = stem.split('@')[0]!;
    test(stem, async () => {
      const written = JSON.parse(readFileSync(`${GOLDEN}/requests/${stem}.json`, 'utf8')) as { method: string }[];
      const recorded = readdirSync(`${GOLDEN}/${stem}`).filter((f) => f.endsWith('.json'));
      expect(recorded.length, `${stem}: one golden per request (rerun just demo-golden)`).toBe(written.length);
      const { loadGraphWasm } = await import('../engine/graph');
      const graph = await loadGraphWasm(gunzipSync(readFileSync(WASM_GZ)));
      const manifest = { version: 1 as const, repos: [{ name, file: `${name}.gbdemo`, group: null, open: 'active' as const }], groups: [] };
      const rt = createRuntime({ manifest, data: goldenData(), graph, clock: fixedClock(PARITY_MS) });
      // The core has no transfer time and no teammate, and the harness's fake forge neither acts
      // on the origin nor reads a clock for its writes.
      netOf(rt.ctx).latencyMs = 0;
      netOf(rt.ctx).schedule = () => undefined;
      const forge = await forgeOf(rt.ctx, netOf(rt.ctx).fs!);
      forge.gitEffects = false;
      forge.fake.now = () => FAKE_WRITE_TIME;
      const t = createDemoTransport(Promise.resolve(rt), HANDLERS);
      const seen: unknown[] = [];
      t.subscribe((e) => void seen.push(e));
      const sideEvents = makeEventNormaliser();
      const goldenEvents = makeEventNormaliser();
      let id: number | null = null;
      for (const [n, req] of written.entries()) {
        const golden = JSON.parse(readFileSync(`${GOLDEN}/${stem}/${n}.json`, 'utf8')) as { request: { method: string }; response?: unknown; error?: unknown; events?: unknown[] };
        expect(golden.request.method, `${stem}/${n}.json answers this request (rerun just demo-golden)`).toBe(req.method);
        const sent = substitute(golden.request, name, id) as Request;
        seen.length = 0;
        const got = await t.call(sent).then((ok) => ({ response: ok }), (err: unknown) => ({ error: err }));
        await new Promise((r) => setTimeout(r, 0)); // the bus delivers in microtasks
        if (sent.method === 'openRepo' && 'response' in got) id = (got.response as { id: number }).id;
        const masked = unreachable(name, sent);
        const side = async (o: { response?: unknown; error?: unknown }, who: 'core' | 'demo') =>
          'error' in o && masked && refusedBy[who](o.error as object) ? { error: '<unreachable>' } : 'response' in o ? { response: await normaliseResponse(sent.method, o.response, name) } : { error: normaliseError(o.error) };
        expect(await side(got, 'demo'), `${stem} #${n} ${sent.method}`).toStrictEqual(await side(golden, 'core'));
        if (golden.events) {
          const mask = (e: unknown[], who: 'core' | 'demo') => (masked ? unreachableEvents(e, who) : e);
          expect(mask(sideEvents(seen), 'demo'), `${stem} #${n} events`).toStrictEqual(mask(goldenEvents(golden.events), 'core'));
        }
      }
    });
  }
});
