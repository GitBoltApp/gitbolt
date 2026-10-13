import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { afterEach, describe, expect, test } from 'vitest';
import { indexVersion, MARKER, packFixture, rewriteAlternates, rewritePaths, scrubIndexStat } from '../../../scripts/pack-demo.mjs';
import { parseBundle } from './bundle';

const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'Mara Quill', GIT_AUTHOR_EMAIL: 'mara@example.com', GIT_COMMITTER_NAME: 'Mara Quill', GIT_COMMITTER_EMAIL: 'mara@example.com', LC_ALL: 'C' };
const gitIn = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, env, encoding: 'utf8' }).trim();
let root = '';
afterEach(() => { if (root) rmSync(root, { recursive: true, force: true }); });

/** <root>/repo with a commit, a bare <root>/origin.git as its origin, a linked <root>/wt-x. With
 *  `alternates`, origin.git borrows the repo's objects instead of holding its own. */
function tinyFixture(alternates = false, originOnly = false): string {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'gitbolt-pack-')));
  const repo = join(root, 'repo');
  mkdirSync(repo);
  gitIn(repo, 'init', '-q', '-b', 'main');
  writeFileSync(join(repo, 'a.txt'), 'one\n');
  writeFileSync(join(repo, 'run.sh'), '#!/bin/sh\n');
  chmodSync(join(repo, 'run.sh'), 0o755);
  symlinkSync('a.txt', join(repo, 'link'));
  gitIn(repo, 'add', '.');
  gitIn(repo, 'commit', '-q', '-m', 'First');
  const origin = join(root, 'origin.git');
  gitIn(root, 'init', '-q', '--bare', '-b', 'main', origin);
  gitIn(repo, 'remote', 'add', 'origin', origin);
  if (alternates) {
    writeFileSync(join(origin, 'objects/info/alternates'), '../../repo/.git/objects\n');
    gitIn(origin, 'update-ref', 'refs/heads/main', gitIn(repo, 'rev-parse', 'HEAD'));
    gitIn(repo, 'fetch', '-q', 'origin');
    gitIn(repo, 'branch', '-q', '-u', 'origin/main');
  } else {
    gitIn(repo, 'push', '-q', '-u', 'origin', 'main');
  }
  if (originOnly) {
    // a commit only the origin's refs reach: plumbing, so no ref or reflog of the repo names it
    const only = gitIn(repo, 'commit-tree', 'HEAD^{tree}', '-p', 'HEAD', '-m', 'Origin only');
    gitIn(origin, 'update-ref', 'refs/heads/origin-only', only);
  }
  gitIn(repo, 'branch', 'side');
  gitIn(repo, 'worktree', 'add', '-q', join(root, 'wt-x'), 'side');
  writeFileSync(join(root, MARKER), '');
  return root;
}

const text = (b: ReturnType<typeof parseBundle>, path: string) => new TextDecoder().decode(b.files.find((f) => f.path === path)?.data);

describe('packFixture', () => {
  test('packs a compacted copy with the demo’s paths and leaves the fixture alone', () => {
    const dir = tinyFixture();
    const b = parseBundle(new Uint8Array(gunzipSync(packFixture(dir, 'tiny'))));
    const paths = b.files.map((f) => f.path);
    expect(b.name).toBe('tiny');
    expect(paths).toContain('repo/.git/packed-refs');
    expect(paths.some((p) => /^repo\/\.git\/objects\/pack\/pack-[0-9a-f]+\.pack$/.test(p))).toBe(true);
    expect(paths.some((p) => /^repo\/\.git\/objects\/[0-9a-f]{2}\//.test(p))).toBe(false);
    expect(paths).not.toContain(MARKER);
    expect(paths.some((p) => p.endsWith('.sample'))).toBe(false);
    expect(paths).toContain('repo/.git/logs/HEAD');
    expect(text(b, 'repo/.git/config')).toContain('url = /demo/.origins/tiny.git');
    expect(text(b, 'wt-x/.git')).toBe('gitdir: /demo/tiny/.git/worktrees/wt-x\n');
    expect(text(b, 'repo/.git/worktrees/wt-x/gitdir')).toBe('/demo/.extra/tiny/wt-x/.git\n');
    expect(b.files.find((f) => f.path === 'repo/run.sh')?.mode).toBe(0o100755);
    expect(b.files.find((f) => f.path === 'repo/link')).toMatchObject({ mode: 0o120000 });
    expect(text(b, 'repo/link')).toBe('a.txt');
    expect(readFileSync(join(dir, 'repo/.git/config'), 'utf8')).toContain(join(dir, 'origin.git'));
    expect(gitIn(join(dir, 'repo'), 'count-objects', '-v')).toMatch(/^count: [1-9]/m);
  });

  test('--in-place compacts the fixture itself', () => {
    const dir = tinyFixture();
    packFixture(dir, 'tiny', { inPlace: true });
    expect(gitIn(join(dir, 'repo'), 'count-objects', '-v')).toMatch(/^count: 0$/m);
    expect(readFileSync(join(dir, 'repo/.git/packed-refs'), 'utf8')).toContain('refs/heads/main');
    expect(readFileSync(join(dir, 'repo/.git/config'), 'utf8')).toContain(join(dir, 'origin.git'));
  });

  test('keeps every stash: the stash list is a reflog', () => {
    const dir = tinyFixture();
    const repo = join(dir, 'repo');
    for (const n of ['one', 'two', 'three']) {
      writeFileSync(join(repo, 'a.txt'), `${n} edit\n`);
      gitIn(repo, 'stash', 'push', '-q', '-m', n);
    }
    const b = parseBundle(new Uint8Array(gunzipSync(packFixture(dir, 'tiny'))));
    expect(text(b, 'repo/.git/logs/refs/stash').trim().split('\n').map((l) => l.split('\t')[1])).toEqual(['On main: one', 'On main: two', 'On main: three']);
    expect(b.files.some((f) => f.path.startsWith('repo/.git/objects/pack/'))).toBe(true);
  });

  test('a bare origin borrowing the repo’s objects stays small and points at the repo’s demo path', () => {
    const dir = tinyFixture(true);
    const b = parseBundle(new Uint8Array(gunzipSync(packFixture(dir, 'tiny'))));
    expect(text(b, 'origin.git/objects/info/alternates')).toBe('/demo/tiny/.git/objects\n');
    const originObjects = b.files.filter((f) => f.path.startsWith('origin.git/objects/') && !f.path.endsWith('/alternates'));
    expect(originObjects.every((f) => f.data.length < 100)).toBe(true);
    expect(b.files.some((f) => /^repo\/\.git\/objects\/pack\/.*\.pack$/.test(f.path) && f.data.length > 100)).toBe(true);
  });

  test('objects only a borrowing origin reaches survive the repo’s compaction', () => {
    const dir = tinyFixture(true, true);
    const b = parseBundle(new Uint8Array(gunzipSync(packFixture(dir, 'tiny'))));
    const out = realpathSync(mkdtempSync(join(tmpdir(), 'gitbolt-unpacked-')));
    for (const f of b.files) {
      mkdirSync(join(out, f.path, '..'), { recursive: true });
      writeFileSync(join(out, f.path), f.data);
    }
    mkdirSync(join(out, 'origin.git/refs'), { recursive: true }); // empty directories aren't bundled
    try {
      // the bundle's alternates name /demo paths: point them at the unpacked copy
      writeFileSync(join(out, 'origin.git/objects/info/alternates'), `${join(out, 'repo/.git/objects')}\n`);
      gitIn(out, '--git-dir=repo/.git', 'fsck', '--strict');
      gitIn(out, '--git-dir=origin.git', 'fsck', '--strict');
      expect(gitIn(out, '--git-dir=origin.git', 'rev-parse', 'refs/heads/origin-only')).toMatch(/^[0-9a-f]{40}$/);
      expect(gitIn(out, '--git-dir=repo/.git', 'for-each-ref', 'refs/borrowed')).toBe('');
      expect(b.files.some((f) => f.path.includes('refs/borrowed') || f.path.includes('logs/refs/borrowed'))).toBe(false);
      expect(text(b, 'repo/.git/packed-refs')).not.toContain('borrowed');
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });

  test('refuses a bad bundle name', () => {
    expect(() => packFixture(tinyFixture(), '../x')).toThrow('bad demo bundle name');
  });

  test('refuses an index isomorphic-git cannot read', () => {
    const dir = tinyFixture();
    gitIn(join(dir, 'repo'), 'update-index', '--index-version', '3');
    gitIn(join(dir, 'repo'), 'update-index', '--skip-worktree', 'a.txt'); // an extended flag: git then writes version 3
    expect(() => packFixture(dir, 'tiny')).toThrow(/repo\/\.git\/index: index version 3/);
  });
});

describe('rewritePaths', () => {
  test('rewrites whole pieces only', () => {
    const pieces = ['repo', 'origin.git', 'wt-x'];
    expect(rewritePaths('url = /f/origin.git\n', '/f', 'tiny', pieces)).toBe('url = /demo/.origins/tiny.git\n');
    expect(rewritePaths('/f/repo/.git/worktrees/wt-x', '/f', 'tiny', pieces)).toBe('/demo/tiny/.git/worktrees/wt-x');
    expect(rewritePaths('/f/repository and /f/wt-x"', '/f', 'tiny', pieces)).toBe('/f/repository and /demo/.extra/tiny/wt-x"');
    expect(rewritePaths('/other/repo', '/f', 'tiny', pieces)).toBe('/other/repo');
    // git names a remote without its `.git` in FETCH_HEAD; a piece of that very name still wins.
    expect(rewritePaths("main' of /f/origin\n", '/f', 'tiny', pieces)).toBe("main' of /demo/.origins/tiny\n");
    expect(rewritePaths('/f/origin and /f/sub-src.git', '/f', 'tiny', ['origin', 'origin.git', 'sub-src.git'])).toBe('/demo/.extra/tiny/origin and /demo/.extra/tiny/sub-src.git');
    expect(rewritePaths('/f/originals', '/f', 'tiny', pieces)).toBe('/f/originals');
  });

  test('rewrites alternates, relative or absolute', () => {
    const pieces = ['repo', 'origin.git'];
    expect(rewriteAlternates('../../repo/.git/objects\n/f/repo/.git/objects\n/elsewhere/objects\n', 'origin.git', '/f', 'tiny', pieces)).toBe('/demo/tiny/.git/objects\n/demo/tiny/.git/objects\n/elsewhere/objects\n');
  });

  test('reads the index version', () => {
    expect(indexVersion(Buffer.from('DIRC\0\0\0\u0002\0\0\0\u0001'))).toBe(2);
    expect(indexVersion(Buffer.from('nope'))).toBeNull();
  });
});

describe('scrubIndexStat', () => {
  // 62 + n + 1 is 64 for n = 1 (exactly a multiple of 8) and 65 for n = 2 (just past); 9 and 10 repeat that at 72.
  const names = ['a', 'bb', 'ccccccccc', 'dddddddddd', 'sub/dir/file.txt', 'sub/x'];

  function repoWithIndex(): string {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'gitbolt-scrub-')));
    gitIn(root, 'init', '-q', '-b', 'main');
    for (const n of names) {
      mkdirSync(join(root, n, '..'), { recursive: true });
      writeFileSync(join(root, n), `${n}\n`);
    }
    gitIn(root, 'add', '.');
    return root;
  }
  const sha = (b: Uint8Array) => createHash('sha1').update(b).digest();
  /** Entries as [start, end) offsets, walking the same layout git writes. */
  function entries(b: Buffer): [number, number][] {
    const out: [number, number][] = [];
    let o = 12;
    for (let i = 0; i < b.readUInt32BE(8); i++) {
      const end = o + Math.ceil((62 + (b.readUInt16BE(o + 60) & 0xfff) + 1) / 8) * 8;
      out.push([o, end]);
      o = end;
    }
    return out;
  }

  test('zeroes only the stat fields, keeps the rest, redoes the checksum', () => {
    const repo = repoWithIndex();
    const input = readFileSync(join(repo, '.git', 'index'));
    const copy = Buffer.from(input);
    const out = scrubIndexStat(input);
    expect(input.equals(copy)).toBe(true);
    expect(out.length).toBe(input.length);
    expect(entries(input)).toHaveLength(names.length);
    for (const [s, e] of entries(input)) {
      expect(out.subarray(s, s + 24).every((x) => x === 0)).toBe(true);
      expect(out.subarray(s + 28, s + 36).every((x) => x === 0)).toBe(true);
      expect(out.subarray(s + 24, s + 28).equals(input.subarray(s + 24, s + 28))).toBe(true);
      expect(out.subarray(s + 36, e).equals(input.subarray(s + 36, e))).toBe(true);
    }
    expect(out.subarray(out.length - 20).equals(sha(out.subarray(0, out.length - 20)))).toBe(true);
    expect(scrubIndexStat(out).equals(out)).toBe(true);
  });

  test('git still reads the scrubbed index and finds the tree clean', () => {
    const repo = repoWithIndex();
    gitIn(repo, 'commit', '-q', '-m', 'First');
    const before = gitIn(repo, 'ls-files', '--stage');
    const idx = join(repo, '.git', 'index');
    writeFileSync(idx, scrubIndexStat(readFileSync(idx)));
    expect(gitIn(repo, 'ls-files', '--stage')).toBe(before);
    gitIn(repo, 'fsck', '--strict');
    expect(gitIn(repo, 'status', '--porcelain')).toBe('');
  });

  test('keeps a TREE extension byte for byte', () => {
    const repo = repoWithIndex();
    gitIn(repo, 'write-tree');
    const input = readFileSync(join(repo, '.git', 'index'));
    const ents = entries(input);
    const extStart = ents[ents.length - 1]![1];
    expect(input.toString('latin1', extStart, extStart + 4)).toBe('TREE');
    const out = scrubIndexStat(input);
    expect(out.subarray(extStart, out.length - 20).equals(input.subarray(extStart, input.length - 20))).toBe(true);
    expect(out.subarray(out.length - 20).equals(sha(out.subarray(0, out.length - 20)))).toBe(true);
  });

  test('two builds of the same content scrub to the same bytes', async () => {
    const a = scrubIndexStat(readFileSync(join(repoWithIndex(), '.git', 'index')));
    rmSync(root, { recursive: true, force: true });
    await new Promise((r) => setTimeout(r, 1100));
    const b = scrubIndexStat(readFileSync(join(repoWithIndex(), '.git', 'index')));
    expect(a.equals(b)).toBe(true);
  });

  test('refuses an index whose entries run past the checksum', () => {
    const input = readFileSync(join(repoWithIndex(), '.git', 'index'));
    const bad = Buffer.from(input);
    bad.writeUInt32BE(1000, 8);
    expect(() => scrubIndexStat(bad)).toThrow(/runs past the checksum/);
  });
});
