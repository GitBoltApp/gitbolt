import { gunzipSync, gzipSync } from 'node:zlib';
import { describe, expect, test } from 'vitest';
import { demoRoot as packerRoot, encodeBundle } from '../../../scripts/pack-demo.mjs';
import { parseBundle, readBundle } from './bundle';
import { basename, demoPath, demoRoot } from './paths';

const file = (path: string, text: string, mode = 0o100644) => ({ path, mode, data: new TextEncoder().encode(text) });

describe('readBundle', () => {
  test('reads what the packer encodes', async () => {
    const files = [file('repo/.git/HEAD', 'ref: refs/heads/main\n'), file('repo/run.sh', '#!/bin/sh\n', 0o100755), file('repo/link', 'run.sh', 0o120000)];
    const b = await readBundle(new Uint8Array(encodeBundle('basic', files)));
    expect(b.name).toBe('basic');
    expect(b.files.map((f) => [f.path, f.mode, new TextDecoder().decode(f.data)])).toEqual([
      ['repo/.git/HEAD', 0o100644, 'ref: refs/heads/main\n'],
      ['repo/run.sh', 0o100755, '#!/bin/sh\n'],
      ['repo/link', 0o120000, 'run.sh'],
    ]);
  });

  test('reads a body a server already unpacked (Content-Encoding: gzip)', async () => {
    const gz = encodeBundle('basic', [file('repo/a', 'x')]);
    expect((await readBundle(new Uint8Array(gunzipSync(gz)))).files[0].path).toBe('repo/a');
  });

  test('refuses what is not a whole, well-formed bundle', async () => {
    await expect(readBundle(new Uint8Array(gzipSync(Buffer.from('PK\u0003\u0004 not a bundle'))))).rejects.toThrow('not a GitBolt demo bundle');
    const raw = new Uint8Array(gunzipSync(encodeBundle('basic', [file('repo/a', 'abc')])));
    expect(() => parseBundle(raw.subarray(0, raw.length - 1))).toThrow('truncated demo bundle (repo/a)');
    expect(() => parseBundle(new Uint8Array([...raw, 0]))).toThrow('trailing bytes');
    expect(() => parseBundle(raw.subarray(0, 14))).toThrow('truncated demo bundle (header)');
  });

  test('refuses paths that would leave the fixture folder, and bad names', () => {
    const unpacked = (name: string, path: string) => new Uint8Array(gunzipSync(encodeBundle(name, [file(path, 'x')])));
    expect(() => parseBundle(unpacked('basic', '../etc/passwd'))).toThrow('bad path in demo bundle');
    expect(() => parseBundle(unpacked('basic', '/abs'))).toThrow('bad path in demo bundle');
    expect(() => parseBundle(unpacked('basic', 'repo//a'))).toThrow('bad path in demo bundle');
    expect(() => parseBundle(unpacked('../x', 'repo/a'))).toThrow('bad demo bundle name');
  });
});

describe('demo paths', () => {
  test('pieces of a fixture folder land where the packer says', () => {
    for (const piece of ['repo', 'origin.git', 'wt-hotfix', 'parser-src']) expect(demoRoot('basic', piece)).toBe(packerRoot('basic', piece));
    expect(demoPath('basic', 'repo/.git/HEAD')).toBe('/demo/basic/.git/HEAD');
    expect(demoPath('basic', 'origin.git/HEAD')).toBe('/demo/.origins/basic.git/HEAD');
    expect(demoPath('basic', 'wt-hotfix/.git')).toBe('/demo/.extra/basic/wt-hotfix/.git');
    expect(demoPath('basic', 'repo')).toBe('/demo/basic');
    expect(basename('/demo/.extra/basic/wt-hotfix')).toBe('wt-hotfix');
  });
});
