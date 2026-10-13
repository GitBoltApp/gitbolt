import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { buildManifest, checkBundle, demoPaths, fixtureDigest, NAMES, overBudget, readBundle, rewritePaths } from './demoBundles';

describe('demoPaths and rewritePaths', () => {
  it('maps the repo, its origin and other pieces to the demo paths', () => {
    const pairs = demoPaths('/tmp/gbdemo-x/orbital', 'orbital', ['repo', 'origin.git', 'netcode-src']);
    expect(rewritePaths('url = /tmp/gbdemo-x/orbital/origin.git\nworktree = /tmp/gbdemo-x/orbital/repo\n', pairs)).toBe('url = /demo/.origins/orbital.git\nworktree = /demo/orbital\n');
    expect(rewritePaths('file:///tmp/gbdemo-x/orbital/netcode-src', pairs)).toBe('file:///demo/.extra/orbital/netcode-src');
  });
  it('replaces the longer of two overlapping names first', () => {
    const pairs = demoPaths('/b/x', 'x', ['repo', 'repo-src']);
    expect(rewritePaths('/b/x/repo-src and /b/x/repo', pairs)).toBe('/demo/.extra/x/repo-src and /demo/x');
  });
});

describe('buildManifest', () => {
  it('opens Orbital as the active tab and the playground in a collapsed group', () => {
    const m = buildManifest(NAMES.map((name) => ({ name, digest: 'd', bytes: 1 })));
    expect(m.version).toBe(1);
    expect(m.repos[0]).toEqual({ name: 'orbital', file: 'orbital.gbdemo', group: null, open: 'active', digest: 'd', bytes: 1 });
    expect(m.repos.slice(1).every((r) => r.group === 'Playground' && r.open === 'tab')).toBe(true);
    expect(m.repos.map((r) => r.name)).toEqual(['orbital', 'basic', 'sync', 'conflicts', 'stack', 'wip_staging', 'rebase_lab', 'previews', 'submodules', 'lfs']);
    expect(m.groups).toEqual([{ name: 'Playground', color: 'blue', collapsed: true }]);
  });
});

describe('overBudget', () => {
  it('passes under the budget and names the biggest bundles over it', () => {
    expect(overBudget({ a: 5_000_000, b: 4_000_000 })).toBeNull();
    const msg = overBudget({ a: 9_000_000, b: 7_000_000 });
    expect(msg).toMatch(/16\.00 MB, over the 15 MB budget: a 9\.00 MB, b 7\.00 MB/);
  });
});

describe('readBundle', () => {
  it('reads the interfaces format', () => {
    const files = [{ path: 'repo/.git/HEAD', mode: 0o100644, body: 'ref: refs/heads/main\n' }, { path: 'repo/link', mode: 0o120000, body: 'target' }];
    const header = Buffer.from(JSON.stringify({ version: 1, name: 'basic', files: files.map((f) => ({ path: f.path, size: Buffer.byteLength(f.body), mode: f.mode })) }));
    const len = Buffer.alloc(4);
    len.writeUInt32LE(header.length);
    const raw = Buffer.concat([Buffer.from('GBDEMO1\n'), len, header, ...files.map((f) => Buffer.from(f.body))]);
    const b = readBundle(gzipSync(raw));
    expect(b.name).toBe('basic');
    expect(b.files.map((f) => [f.path, Buffer.from(f.bytes).toString(), f.mode])).toEqual([['repo/.git/HEAD', 'ref: refs/heads/main\n', 0o100644], ['repo/link', 'target', 0o120000]]);
    expect(() => readBundle(gzipSync(Buffer.from('NOPE')))).toThrow(/not a \.gbdemo/);
  });
});

function bundle(files: { path: string; body: string }[], name = 'basic'): Uint8Array {
  const header = Buffer.from(JSON.stringify({ version: 1, name, files: files.map((f) => ({ path: f.path, size: Buffer.byteLength(f.body), mode: 0o100644 })) }));
  const len = Buffer.alloc(4);
  len.writeUInt32LE(header.length);
  return gzipSync(Buffer.concat([Buffer.from('GBDEMO1\n'), len, header, ...files.map((f) => Buffer.from(f.body))]));
}

describe('checkBundle', () => {
  it('flags a build path in any file, and a home or tmp path in git text files', () => {
    expect(checkBundle('basic', bundle([{ path: 'repo/a.txt', body: 'ok' }]), '/tmp/gbdemo-')).toEqual([]);
    expect(checkBundle('basic', bundle([{ path: 'repo/a.txt', body: 'at /tmp/gbdemo-x/repo' }]), '/tmp/gbdemo-')).toEqual(['repo/a.txt holds a build path']);
    expect(checkBundle('basic', bundle([{ path: 'repo/.git/config', body: 'url = /home/me/x' }]), '/tmp/gbdemo-')).toEqual(['repo/.git/config holds a build path']);
    expect(checkBundle('basic', bundle([{ path: 'repo/.git/objects/pack/p', body: '/home/' }]), '/tmp/gbdemo-')).toEqual([]);
  });
});

describe('fixtureDigest', () => {
  const make = (files: Record<string, string>) => {
    const dir = mkdtempSync(join(tmpdir(), 'gbdigest-'));
    for (const [p, body] of Object.entries(files)) {
      mkdirSync(join(dir, p, '..'), { recursive: true });
      writeFileSync(join(dir, p), body);
    }
    return dir;
  };
  it('follows content and path rewriting, not the build directory', () => {
    const a = make({ 'repo/a.txt': 'one', 'origin.git/config': 'url = BUILD/origin.git' });
    const b = make({ 'repo/a.txt': 'one', 'origin.git/config': 'url = BUILD/origin.git' });
    const c = make({ 'repo/a.txt': 'two', 'origin.git/config': 'url = BUILD/origin.git' });
    try {
      const pairs = (_d: string): [string, string][] => [['BUILD', '/demo']];
      expect(fixtureDigest(a, pairs(a))).toBe(fixtureDigest(b, pairs(b)));
      expect(fixtureDigest(a, pairs(a))).not.toBe(fixtureDigest(c, pairs(c)));
      expect(fixtureDigest(a, [])).not.toBe(fixtureDigest(a, pairs(a)));
    } finally {
      for (const d of [a, b, c]) rmSync(d, { recursive: true, force: true });
    }
  });
});
