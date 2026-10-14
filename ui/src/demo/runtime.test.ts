import { afterEach, expect, test, vi } from 'vitest';
import { MemFs } from './engine/memfs';
import { type DemoData, DemoRepos, type Manifest } from './engine/repos';
import { HANDLERS } from './handlers';
import { createRuntime, httpData } from './runtime';
import { noGraph } from './testing';
import { createDemoTransport } from './transport';

afterEach(() => { vi.unstubAllGlobals(); });

test("the demo's data comes from demo-data/ next to the page", async () => {
  const urls: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (u: URL) => {
    urls.push(String(u));
    return String(u).endsWith('.json') ? new Response('{"version":1,"repos":[],"groups":[]}') : new Response(new Uint8Array([1, 2]));
  }));
  const data = httpData(new URL('demo-data/', 'https://demo.example.com/gitvolt/demo/demo.html'));
  expect(await data.manifest()).toEqual({ version: 1, repos: [], groups: [] });
  expect(await data.bundle('basic.gbdemo')).toEqual(new Uint8Array([1, 2]));
  expect(urls).toEqual(['https://demo.example.com/gitvolt/demo/demo-data/manifest.json', 'https://demo.example.com/gitvolt/demo/demo-data/basic.gbdemo']);
});

test("the build's rev and each bundle's go in the query, so a deploy never mixes with a cached copy", async () => {
  const urls: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (u: URL) => {
    urls.push(String(u));
    return String(u).includes('.json') ? new Response('{"version":1,"repos":[],"groups":[]}') : new Response(new Uint8Array([1]));
  }));
  const data = httpData(new URL('demo-data/', 'https://demo.example.com/gitvolt/demo/demo.html'), '0123456789ab');
  await data.manifest();
  await data.bundle('basic.gbdemo', 'ba5e0000cafe');
  expect(urls).toEqual([
    'https://demo.example.com/gitvolt/demo/demo-data/manifest.json?v=0123456789ab',
    'https://demo.example.com/gitvolt/demo/demo-data/basic.gbdemo?v=ba5e0000cafe',
  ]);
});

test("a repository's bundle is fetched with the rev the manifest gives it", async () => {
  const calls: [string, string | undefined][] = [];
  const manifest: Manifest = { version: 1, repos: [{ name: 'basic', file: 'basic.gbdemo', group: null, open: 'active', rev: '0123456789ab' }], groups: [] };
  const data: DemoData = {
    manifest: async () => manifest,
    bundle: async (file, rev) => {
      calls.push([file, rev]);
      throw new Error('stop');
    },
  };
  await expect(new DemoRepos(manifest, data, new MemFs(), noGraph).locate('/demo/basic')).rejects.toThrow('stop');
  expect(calls).toEqual([['basic.gbdemo', '0123456789ab']]);
});

test('missing data fails every call with what is missing, instead of hanging', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 404 })));
  const data = httpData(new URL('https://demo.example.com/demo-data/'));
  const runtime = (async () => createRuntime({ manifest: await data.manifest(), data, graph: noGraph }))();
  const t = createDemoTransport(runtime, HANDLERS);
  await expect(t.call({ method: 'loadState' })).rejects.toEqual({ kind: 'NotFound', message: "The demo's data is missing: manifest.json (404)", commandId: null, stderr: null });
  await expect(t.call({ method: 'unwatchAll' })).rejects.toMatchObject({ kind: 'NotFound' });
});
