import { existsSync, readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import * as git from 'isomorphic-git';
import { describe, expect, it } from 'vitest';
import type { GraphFactory } from '../engine/layout';
import { WASM_GZ } from '../testing';
import { findHandlers, setFindWindow } from './find';
import { ADA, fakeCtx, makeTestRepo, stash } from '../engine/read/testkit';

async function sixty(graph?: GraphFactory) {
  const t = await makeTestRepo('test', graph);
  const ids: string[] = [];
  for (let i = 0; i < 60; i++) {
    await t.write(`file_${i}.txt`, `content ${i}\n`);
    ids.push(await t.commit(`Commit ${String(i).padStart(2, '0')}`, ADA, { only: [`file_${i}.txt`] }));
  }
  const newestFirst = [...ids].reverse();
  const ctx = fakeCtx(t.repo);
  return { t, ids, newestFirst, ctx };
}

describe('find handlers', () => {
  it('refuses before the graph', async () => {
    const { ctx } = await sixty();
    await expect(findHandlers.findText({ repo: 1, query: 'commit' }, ctx)).rejects.toMatchObject({ kind: 'InvalidInput', message: 'load the graph before searching it' });
    await expect(findHandlers.searchHistory({ repo: 1, query: 'commit' }, ctx)).rejects.toMatchObject({ kind: 'InvalidInput' });
  });

  it('finds messages and hash prefixes in the window, in window order', async () => {
    const { newestFirst, ctx } = await sixty();
    setFindWindow(ctx, 1, newestFirst.slice(0, 20));
    expect(await findHandlers.findText({ repo: 1, query: '  COMMIT 5  ' }, ctx)).toEqual(newestFirst.slice(0, 10));
    expect(await findHandlers.findText({ repo: 1, query: newestFirst[3].slice(0, 8) }, ctx)).toEqual([newestFirst[3]]);
    expect(await findHandlers.findText({ repo: 1, query: '' }, ctx)).toEqual([]);
  });

  it('finds commits by the paths they changed', async () => {
    const { newestFirst, ctx } = await sixty();
    setFindWindow(ctx, 1, newestFirst.slice(0, 20));
    expect(await findHandlers.findPaths({ repo: 1, query: 'FILE_59' }, ctx)).toEqual([newestFirst[0]]);
    expect(await findHandlers.findPaths({ repo: 1, query: 'f' }, ctx)).toEqual([]);
  });

  it('locates a commit in the window, or not at all', async () => {
    const { newestFirst, ctx } = await sixty();
    setFindWindow(ctx, 1, newestFirst.slice(0, 20));
    expect(await findHandlers.locateCommit({ repo: 1, sha: newestFirst[2].slice(0, 10) }, ctx)).toEqual({ found: true, limit: null, id: newestFirst[2], ambiguous: false });
    await expect(findHandlers.locateCommit({ repo: 1, sha: 'ffffffffff' }, ctx)).rejects.toMatchObject({ kind: 'NotFound', message: 'No commit ffffffffff' });
  });

  it.skipIf(!existsSync(WASM_GZ))('locates a commit deeper in the graph walk (needs `just demo-wasm`)', async () => {
    const { loadGraphWasm } = await import('../engine/graph');
    const { ids, newestFirst, ctx } = await sixty(await loadGraphWasm(gunzipSync(readFileSync(WASM_GZ))));
    setFindWindow(ctx, 1, newestFirst.slice(0, 20));
    expect(await findHandlers.locateCommit({ repo: 1, sha: ids[0] }, ctx)).toEqual({ found: true, limit: 60, id: ids[0], ambiguous: false });
  });

  it('an ambiguous prefix is ambiguous, not an error', async () => {
    const t = await makeTestRepo();
    await t.write('a.txt', 'a\n');
    const base = await t.commit('Base');
    const io = t.memfs;
    const sig = { ...ADA, timestamp: 1_767_300_000, timezoneOffset: 0 };
    const make = (i: number, dryRun: boolean) => git.commit({ fs: io, dir: t.dir, message: `Try ${i}`, author: sig, committer: sig, parent: [base], noUpdateBranch: true, dryRun });
    // Dry runs until two commit ids share their first four hex digits (a few hundred tries), then both are written.
    const seen = new Map<string, number>();
    let pair: [number, number] | null = null;
    for (let i = 0; pair === null; i++) {
      const prefix = (await make(i, true)).slice(0, 4);
      const j = seen.get(prefix);
      if (j === undefined) seen.set(prefix, i);
      else pair = [j, i];
    }
    const a = await make(pair![0], false);
    await make(pair![1], false);
    const ctx = fakeCtx(t.repo);
    setFindWindow(ctx, 1, [base]);
    expect(await findHandlers.locateCommit({ repo: 1, sha: a.slice(0, 4) }, ctx)).toEqual({ found: false, limit: null, id: null, ambiguous: true });
  });

  it('searches older history by message and by path, newest first, outside the window', async () => {
    const { t, newestFirst, ctx } = await sixty();
    setFindWindow(ctx, 1, newestFirst.slice(0, 50));
    const hits = await findHandlers.searchHistory({ repo: 1, query: 'commit 0' }, ctx);
    expect(hits.map((h) => h.summary)).toEqual(['Commit 09', 'Commit 08', 'Commit 07', 'Commit 06', 'Commit 05', 'Commit 04', 'Commit 03', 'Commit 02', 'Commit 01', 'Commit 00']);
    expect(hits[0]).toMatchObject({ author: 'Ada Lovelace' });
    const byPath = await findHandlers.searchHistory({ repo: 1, query: 'FILE_3.' }, ctx);
    expect(byPath.map((h) => h.summary)).toEqual(['Commit 03']);
    await t.write('file_0.txt', 'stashed\n');
    const s = await stash(t, 'Experiment');
    const withStash = await findHandlers.searchHistory({ repo: 1, query: 'experiment' }, ctx);
    expect(withStash.map((h) => h.id)).toEqual([s]);
  });
});
