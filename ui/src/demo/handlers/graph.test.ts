import { existsSync, readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { describe, expect, test } from 'vitest';
import type { GraphPayload } from '../../api/gen/GraphPayload';
import type { RepoSummary } from '../../api/gen/RepoSummary';
import { createRuntime } from '../runtime';
import { goldenData, goldenManifest, WASM_GZ } from '../testing';
import { createDemoTransport } from '../transport';
import { HANDLERS } from '.';

describe.skipIf(!existsSync(WASM_GZ))('the graph handler (needs `just demo-wasm`)', () => {
  test('lays basic out through the WebAssembly pipeline', async () => {
    const { loadGraphWasm } = await import('../engine/graph');
    const graph = await loadGraphWasm(gunzipSync(readFileSync(WASM_GZ)));
    const runtime = createRuntime({ manifest: goldenManifest(), data: goldenData(), graph });
    const t = createDemoTransport(Promise.resolve(runtime), HANDLERS);
    const { id } = (await t.call({ method: 'openRepo', params: { path: '/demo/basic' } })) as RepoSummary;
    const g = (await t.call({ method: 'graph', params: { repo: id, limit: null } })) as GraphPayload;
    expect(g.rows).toHaveLength(10);
    const commitIds = g.rows.filter((r) => r.kind !== 'wip').map((r) => r.id);
    const order = await runtime.ctx.repos.get(id).walkOrder(2000);
    expect(new Set(order)).toEqual(new Set(commitIds));
    expect(order).toHaveLength(commitIds.length);
    expect(g.rows.filter((r) => r.kind === 'wip').map((r) => r.id)).toEqual(['wip:/demo/basic', 'wip:/demo/.extra/basic/wt-hotfix']);
    expect(g.pinnedRefs).toEqual(['refs/heads/main', 'refs/remotes/origin/main']);
    expect(g.rows.some((r) => r.kind === 'stash')).toBe(true);
    const off = (await t.call({ method: 'graph', params: { repo: id, limit: null, pin: { kind: 'off' } } })) as GraphPayload;
    expect(off.pinnedRefs).toEqual([]);
    await expect(t.call({ method: 'graph', params: { repo: id, limit: null, active: '/elsewhere' } })).rejects.toMatchObject({ kind: 'InvalidInput', message: '/elsewhere is not a worktree of this repository' });
  });
});
