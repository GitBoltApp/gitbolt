// The demo backend against the real core (website demo spec §4.4): each fixture's bundle answers
// the requests recorded in golden/<fixture>/, and each answer must be the one the harness gave on
// the same fixture (`just demo-golden`). Skipped until `just demo-wasm` has built the graph.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { describe, expect, test } from 'vitest';
import type { Request } from '../../api/gen/Request';
import { demoRoot } from '../engine/paths';
import { HANDLERS } from '../handlers';
import { createRuntime } from '../runtime';
import { GOLDEN, goldenData, WASM_GZ } from '../testing';
import { createDemoTransport } from '../transport';
import { normaliseResponse } from './normalise';

const fixtures = readdirSync(`${GOLDEN}/requests`).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5));

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
  for (const name of fixtures) {
    test(name, async () => {
      const written = JSON.parse(readFileSync(`${GOLDEN}/requests/${name}.json`, 'utf8')) as { method: string }[];
      const recorded = readdirSync(`${GOLDEN}/${name}`).filter((f) => f.endsWith('.json'));
      expect(recorded.length, `${name}: one golden per request (rerun just demo-golden)`).toBe(written.length);
      const { loadGraphWasm } = await import('../engine/graph');
      const graph = await loadGraphWasm(gunzipSync(readFileSync(WASM_GZ)));
      const manifest = { version: 1 as const, repos: [{ name, file: `${name}.gbdemo`, group: null, open: 'active' as const }], groups: [] };
      const t = createDemoTransport(Promise.resolve(createRuntime({ manifest, data: goldenData(), graph })), HANDLERS);
      let id: number | null = null;
      for (const [n, req] of written.entries()) {
        const golden = JSON.parse(readFileSync(`${GOLDEN}/${name}/${n}.json`, 'utf8')) as { request: { method: string }; response?: unknown; error?: unknown };
        expect(golden.request.method, `${name}/${n}.json answers this request (rerun just demo-golden)`).toBe(req.method);
        const sent = substitute(golden.request, name, id) as Request;
        const got = await t.call(sent).then((ok) => ({ response: ok }), (err: unknown) => ({ error: err }));
        if (sent.method === 'openRepo' && 'response' in got) id = (got.response as { id: number }).id;
        const side = async (o: { response?: unknown; error?: unknown }) => ('response' in o ? { response: await normaliseResponse(sent.method, o.response) } : { error: await normaliseResponse(sent.method, o.error) });
        expect(await side(got), `${name} #${n} ${sent.method}`).toStrictEqual(await side(golden));
      }
    });
  }
});
