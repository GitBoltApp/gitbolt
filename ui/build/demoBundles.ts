// `just demo-data`: builds each showcase repository with the harness, rewrites the build's
// absolute paths to the demo's (/demo/<name>, /demo/.origins/<name>.git,
// /demo/.extra/<name>/<piece>), packs it with plan 1a's pack-demo.mjs into
// site/demo-data/<name>.gbdemo, checks the bundle, and writes manifest.json. A repo whose content
// digest hasn't changed keeps its committed bundle, so a re-run changes nothing. Fails over the
// 15 MB budget.
//
//   node ui/build/demoBundles.ts <harness> <out dir>
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { gunzipSync } from 'node:zlib';

export const NAMES = ['orbital', 'basic', 'sync', 'conflicts', 'stack', 'wip_staging', 'rebase_lab', 'previews', 'submodules', 'lfs'] as const;
export const BUDGET = 15_000_000;
export const FORMAT = 1;
const BUILD_PREFIX = 'gbdemo-';

export interface ManifestRepo { name: string; file: string; group: string | null; open: 'active' | 'tab'; digest: string; bytes: number }
export interface Manifest { version: 1; repos: ManifestRepo[]; groups: { name: string; color: string; collapsed: boolean }[] }
export interface BundleFile { path: string; size: number; mode: number; bytes: Uint8Array }

const PACKER = join(import.meta.dirname, '..', 'scripts', 'pack-demo.mjs');
const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', LC_ALL: 'C' };
const git = (cwd: string, args: string[]) => execFileSync('git', args, { cwd, env: gitEnv, encoding: 'utf8', maxBuffer: 1 << 28 });

export function demoPaths(buildDir: string, name: string, pieces: string[]): [string, string][] {
  const to = (p: string) => (p === 'repo' ? `/demo/${name}` : p === 'origin.git' ? `/demo/.origins/${name}.git` : `/demo/.extra/${name}/${p}`);
  return pieces.map((p): [string, string] => [join(buildDir, p), to(p)]).sort((a, b) => b[0].length - a[0].length);
}

export function rewritePaths(text: string, pairs: [string, string][]): string {
  return pairs.reduce((t, [from, to]) => t.split(from).join(to), text);
}

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (lstatSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

const isGitSeg = (s: string) => s === '.git' || s.endsWith('.git');

/** What's in the fixture, not how it's stored: refs, stashes, index entries, status, the files
 * outside git directories, and git's small text files. Stable across rebuilds of the same content. */
export function fixtureDigest(dir: string, pairs: [string, string][] = []): string {
  const h = createHash('sha256');
  h.update(`format ${FORMAT}\n`);
  // A packer change (what it scrubs or rewrites) changes the bundle, so it counts as content.
  h.update(readFileSync(PACKER));
  const files = walk(dir).sort();
  for (const file of files) {
    const rel = relative(dir, file);
    const segs = rel.split('/');
    if (segs.some(isGitSeg)) {
      const last = segs.at(-1)!;
      if (!segs.includes('logs') && (['config', 'HEAD', 'packed-refs', 'alternates', 'gitdir'].includes(last) || segs.includes('refs'))) h.update(`${rel}\n${rewritePaths(readFileSync(file, 'latin1'), pairs)}\n`);
      continue;
    }
    const bytes = lstatSync(file).isSymbolicLink() ? Buffer.from(readlinkSync(file)) : readFileSync(file);
    h.update(`${rel} ${createHash('sha256').update(bytes).digest('hex')}\n`);
  }
  const workTrees = [...new Set(files.filter((f) => relative(dir, f).split('/').includes('.git')).map((f) => { const segs = relative(dir, f).split('/'); return join(dir, ...segs.slice(0, segs.indexOf('.git'))); }))].sort();
  for (const wt of workTrees.filter((w) => !relative(dir, w).split('/').includes('modules'))) {
    h.update(git(wt, ['for-each-ref', '--format=%(objectname) %(refname)']));
    h.update(git(wt, ['stash', 'list', '--format=%H']));
    h.update(git(wt, ['ls-files', '-s']));
    h.update(git(wt, ['status', '--porcelain=v1', '-uall']));
  }
  return h.digest('hex').slice(0, 16);
}

export function buildManifest(entries: { name: string; digest: string; bytes: number }[]): Manifest {
  return {
    version: 1,
    repos: entries.map((e) => ({ name: e.name, file: `${e.name}.gbdemo`, group: e.name === 'orbital' ? null : 'Playground', open: e.name === 'orbital' ? 'active' : 'tab', digest: e.digest, bytes: e.bytes })),
    groups: [{ name: 'Playground', color: 'blue', collapsed: true }],
  };
}

export function overBudget(sizes: Record<string, number>, budget = BUDGET): string | null {
  const total = Object.values(sizes).reduce((a, b) => a + b, 0);
  if (total < budget) return null;
  const list = Object.entries(sizes).sort((a, b) => b[1] - a[1]).map(([n, s]) => `${n} ${(s / 1e6).toFixed(2)} MB`).join(', ');
  return `bundles total ${(total / 1e6).toFixed(2)} MB, over the ${(budget / 1e6).toFixed(0)} MB budget: ${list}`;
}

export function readBundle(gz: Uint8Array): { name: string; files: BundleFile[] } {
  const raw = gunzipSync(gz);
  if (raw.length < 12 || raw.subarray(0, 8).toString('latin1') !== 'GBDEMO1\n') throw new Error('not a .gbdemo bundle');
  const n = raw.readUInt32LE(8);
  const header = JSON.parse(raw.subarray(12, 12 + n).toString('utf8')) as { name: string; files: { path: string; size: number; mode: number }[] };
  let at = 12 + n;
  const files = header.files.map((f) => {
    const bytes = raw.subarray(at, at + f.size);
    at += f.size;
    return { ...f, bytes };
  });
  return { name: header.name, files };
}

/** Unpacks into `dir` the way the demo's file system sees it: the bundle has no empty directories
 * (a git dir needs `objects` and `refs`), and an alternates line still names the demo's path. */
function extract(files: BundleFile[], dir: string, name: string): void {
  for (const f of files) {
    const gitDir = /^(.*?\.git)\//.exec(f.path)?.[1];
    if (gitDir) for (const d of ['objects', 'refs']) mkdirSync(join(dir, gitDir, d), { recursive: true });
    const p = join(dir, f.path);
    mkdirSync(dirname(p), { recursive: true });
    if (f.mode === 0o120000) symlinkSync(Buffer.from(f.bytes).toString('utf8'), p);
    else {
      writeFileSync(p, f.path.endsWith('objects/info/alternates') ? Buffer.from(f.bytes).toString('utf8').split(`/demo/${name}/`).join(`${dir}/repo/`) : f.bytes);
      chmodSync(p, f.mode & 0o777);
    }
  }
}

export function checkBundle(name: string, gz: Uint8Array, buildPrefix: string): string[] {
  const problems: string[] = [];
  const { files } = readBundle(gz);
  const needle = Buffer.from(buildPrefix);
  for (const f of files) {
    const bytes = Buffer.from(f.bytes);
    // Packs and the working tree's binaries may hold the bytes by chance; git's own text files don't.
    const stray = !/(^|\/)objects\//.test(f.path) && /\.git\//.test(f.path) && ['/tmp/', '/home/', '/Users/'].some((p) => bytes.includes(p));
    if (bytes.includes(needle) || stray) problems.push(`${f.path} holds a build path`);
  }
  if (name !== 'orbital') return problems;
  const dir = mkdtempSync(join(tmpdir(), 'gbcheck-'));
  try {
    extract(files, dir, name);
    const at = (p: string, args: string[]) => git(join(dir, p), args).trim();
    if (at('repo', ['stash', 'list']).split('\n').filter(Boolean).length !== 2) problems.push('the stash list lost entries (the packer must keep refs/stash\'s reflog)');
    const status = at('repo', ['status', '--porcelain']);
    for (const [re, what] of [[/^MM /m, 'a partly staged file'], [/^M {2}/m, 'a staged file'], [/^ M /m, 'an unstaged file'], [/^\?\? /m, 'an untracked file']] as const) {
      if (!re.test(status)) problems.push(`the working tree lost ${what}:\n${status}`);
    }
    if (at('origin.git', ['rev-list', '--count', 'refs/heads/main..refs/demo/teammate']) !== '1') problems.push("the origin lost the teammate's commit");
    if (Number(at('repo', ['rev-list', '--all', '--count'])) < 1_300) problems.push('the history is short');
    if (!files.some((f) => f.path === 'forge.json')) problems.push('forge.json is missing');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  return problems;
}

function main(): void {
  const [harness, outDir] = process.argv.slice(2);
  if (!harness || !outDir) throw new Error('usage: node ui/build/demoBundles.ts <harness> <out dir>');
  mkdirSync(outDir, { recursive: true });
  const manifestPath = join(outDir, 'manifest.json');
  const previous: Manifest | null = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, 'utf8')) : null;
  const work = mkdtempSync(join(tmpdir(), BUILD_PREFIX));
  const entries: { name: string; digest: string; bytes: number }[] = [];
  const sizes: Record<string, number> = {};
  const problems: string[] = [];
  try {
    for (const name of NAMES) {
      const dir = join(work, name);
      execFileSync(harness, ['showcase', name, dir], { stdio: ['ignore', 'ignore', 'inherit'] });
      // The packer rewrites the build paths itself (and needs the alternates as built); the digest
      // sees the demo's paths so it doesn't depend on the temp dir.
      const digest = fixtureDigest(dir, demoPaths(dir, name, readdirSync(dir).filter((p) => !p.startsWith('.'))));
      const out = join(outDir, `${name}.gbdemo`);
      const kept = existsSync(out) && previous?.repos.some((r) => r.name === name && r.digest === digest);
      if (!kept) execFileSync('node', [PACKER, dir, out], { stdio: 'inherit' });
      const gz = readFileSync(out);
      problems.push(...checkBundle(name, gz, join(tmpdir(), BUILD_PREFIX)).map((p) => `${name}: ${p}`));
      sizes[name] = gz.length;
      entries.push({ name, digest, bytes: gz.length });
      console.log(`${name.padEnd(12)} ${(gz.length / 1e6).toFixed(2)} MB${kept ? ' (unchanged)' : ''}`);
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  const over = overBudget(sizes);
  if (over) problems.push(over);
  if (problems.length) throw new Error(problems.join('\n'));
  writeFileSync(manifestPath, `${JSON.stringify(buildManifest(entries), null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (e) {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  }
}
