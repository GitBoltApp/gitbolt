// Packs a harness fixture folder (`gitbolt-harness fixture <name> <dir>`) into a website-demo
// bundle, `.gbdemo`: gzip of "GBDEMO1\n", a u32 LE header length, a JSON header
// ({ version: 1, name, files: [{ path, size, mode }] }) and the files' bytes in header order
// (docs/superpowers/specs/2026-10-12-gitbolt-website-demo-interfaces.md).
//
// It works on a copy (or the folder itself with --in-place, as `just demo-golden` does so the
// harness answers from exactly what was packed): each git directory is compacted (one pack,
// packed refs, no unreachable loose objects; reflogs are kept, since git reads the stash list
// from one; objects borrowed through alternates are not copied), every path into the fixture in
// git's metadata (absolute, or an alternates line's relative one) is rewritten to where the demo
// keeps that piece (demoRoot), and an index isomorphic-git can't read (not version 2) is refused.
//
//   node ui/scripts/pack-demo.mjs [--in-place] <fixtureDir> <out.gbdemo>   (name: out's basename)
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, existsSync, lstatSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, posix, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';

export const MAGIC = 'GBDEMO1\n';
/** The harness's fixture marker (`gitbolt_core::testing::FIXTURE_MARKER`): not part of the bundle. */
export const MARKER = '.gitbolt-fixture';
const REWRITE_MAX = 1 << 20;
const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', LC_ALL: 'C' };

/** Where a fixture folder's top-level piece lives in the demo's file system (`demoRoot` in
 *  ui/src/demo/engine/paths.ts and `golden::demo_root` in the harness say the same). */
export function demoRoot(name, piece) {
  if (piece === 'repo') return `/demo/${name}`;
  if (piece === 'origin.git') return `/demo/.origins/${name}.git`;
  return `/demo/.extra/${name}/${piece}`;
}

/** `text` with every `<root>/<piece>` (a whole piece: followed by the end, `/`, whitespace, a quote
 *  or NUL) pointing at the demo's copy. A bare `x.git` piece also matches as `x`, the form git
 *  writes a URL in (FETCH_HEAD's "branch 'main' of <url>"), and becomes the demo's copy without
 *  `.git` likewise. */
export function rewritePaths(text, root, name, pieces) {
  const prefix = `${root}/`;
  const targets = new Map(pieces.map((p) => [p, demoRoot(name, p)]));
  for (const p of pieces) {
    const bare = p.slice(0, -'.git'.length);
    if (p.endsWith('.git') && bare !== '' && !targets.has(bare)) targets.set(bare, demoRoot(name, p).slice(0, -'.git'.length));
  }
  const sorted = [...targets.keys()].sort((a, b) => b.length - a.length);
  let out = '';
  let i = 0;
  for (;;) {
    const at = text.indexOf(prefix, i);
    if (at < 0) return out + text.slice(i);
    out += text.slice(i, at);
    const rest = text.slice(at + prefix.length);
    const piece = sorted.find((p) => rest.startsWith(p) && (rest.length === p.length || /[/\s"'\0]/.test(rest[p.length])));
    if (piece) {
      out += targets.get(piece);
      i = at + prefix.length + piece.length;
    } else {
      out += prefix;
      i = at + prefix.length;
    }
  }
}

/** An `objects/info/alternates` file: each line is a directory, absolute or relative to the
 *  `objects` directory of the git dir `gitDirRel` (relative to the fixture folder `root`); one
 *  inside the fixture becomes the demo's path of that piece. */
export function rewriteAlternates(text, gitDirRel, root, name, pieces) {
  return text
    .split('\n')
    .map((line) => {
      if (line === '' || line.startsWith('#')) return line;
      if (line.startsWith('/')) return rewritePaths(line, root, name, pieces);
      const rel = posix.normalize(posix.join(gitDirRel, 'objects', line));
      const piece = pieces.find((p) => rel === p || rel.startsWith(`${p}/`));
      return piece ? demoRoot(name, piece) + rel.slice(piece.length) : line;
    })
    .join('\n');
}

/** A bundle of `files` ({ path, mode, data }), gzipped (level 9: deterministic, mtime 0). */
export function encodeBundle(name, files) {
  const header = Buffer.from(JSON.stringify({ version: 1, name, files: files.map(({ path, mode, data }) => ({ path, size: data.length, mode })) }), 'utf8');
  const len = Buffer.alloc(4);
  len.writeUInt32LE(header.length);
  return gzipSync(Buffer.concat([Buffer.from(MAGIC, 'utf8'), len, header, ...files.map((f) => Buffer.from(f.data))]), { level: 9 });
}

/** A git index's version, or null when `buf` isn't an index. */
export function indexVersion(buf) {
  const b = Buffer.from(buf);
  return b.length >= 12 && b.toString('latin1', 0, 4) === 'DIRC' ? b.readUInt32BE(4) : null;
}

/** A v2 index without its stat noise (times, device, inode, owner), checksum redone: the bundle then
 *  doesn't depend on when or where the fixture was built. Content hashes, modes and sizes stay. */
export function scrubIndexStat(buf) {
  const b = Buffer.from(buf);
  const count = b.readUInt32BE(8);
  let o = 12;
  for (let i = 0; i < count; i++) {
    if (o + 62 > b.length - 20) throw new Error(`index entry ${i} of ${count} runs past the checksum`);
    b.fill(0, o, o + 24);
    b.fill(0, o + 28, o + 36);
    // The flags' 12-bit length saturates at 0xfff (names of 4095 bytes or more, unreachable for fixtures).
    const nameLen = b.readUInt16BE(o + 60) & 0xfff;
    o += Math.ceil((62 + nameLen + 1) / 8) * 8;
    if (o > b.length - 20) throw new Error(`index entry ${i} of ${count} runs past the checksum`);
  }
  createHash('sha1').update(b.subarray(0, b.length - 20)).digest().copy(b, b.length - 20);
  return b;
}

function* walk(dir, base) {
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name);
    const st = lstatSync(path);
    if (st.isDirectory()) yield* walk(path, base);
    else yield { rel: relative(base, path).split(sep).join('/'), path, st };
  }
}

/** The git directories of a fixture folder: `repo/.git` and every bare `*.git` piece. */
function gitDirs(dir) {
  const pieces = readdirSync(dir);
  return [
    ...(existsSync(join(dir, 'repo', '.git')) && lstatSync(join(dir, 'repo', '.git')).isDirectory() ? [join(dir, 'repo', '.git')] : []),
    ...pieces.filter((p) => p.endsWith('.git') && existsSync(join(dir, p, 'HEAD'))).map((p) => join(dir, p)),
  ];
}

/** One pack (single-threaded, so the same fixture packs to the same bytes; `-l` leaves out objects
 *  borrowed through alternates), packed refs, no unreachable loose objects. Reflogs stay. */
function compact(gitDir) {
  const git = (...args) => execFileSync('git', [`--git-dir=${gitDir}`, '-c', 'pack.threads=1', '-c', 'pack.writeReverseIndex=false', '-c', 'repack.writeBitmaps=false', ...args], { env: GIT_ENV, stdio: ['ignore', 'ignore', 'inherit'] });
  git('repack', '-adlq');
  git('pack-refs', '--all');
  git('prune');
}

/** Pins, with temporary `refs/borrowed/<n>/...` refs, every object the git dirs that borrow from
 *  another through alternates reach, so compacting the lender (which prunes what its own refs
 *  don't reach) leaves them. Returns a function that removes the refs again. */
function pinBorrowed(work, src, gitDirs) {
  const pinned = [];
  gitDirs.forEach((g, n) => {
    const alt = join(g, 'objects/info/alternates');
    if (!existsSync(alt)) return;
    const refs = execFileSync('git', [`--git-dir=${g}`, 'for-each-ref', '--format=%(objectname) %(refname)'], { env: GIT_ENV, encoding: 'utf8' }).split('\n').filter(Boolean);
    for (const line of readFileSync(alt, 'utf8').split('\n')) {
      if (line === '' || line.startsWith('#')) continue;
      let lender = resolve(g, 'objects', line);
      if (lender.startsWith(`${src}/`)) lender = join(work, lender.slice(src.length));
      const lenderGit = dirname(lender);
      if (!lenderGit.startsWith(`${work}/`) || lenderGit === g || !existsSync(join(lenderGit, 'HEAD'))) continue;
      for (const r of refs) {
        const [sha, name] = r.split(' ');
        // A ref whose object the borrower holds itself (a teammate's commit pushed to an origin) needs no pin.
        if (spawnSync('git', [`--git-dir=${lenderGit}`, 'cat-file', '-e', sha], { env: GIT_ENV }).status !== 0) continue;
        const pin = `refs/borrowed/${n}/${name.replace(/^refs\//, '')}`;
        execFileSync('git', [`--git-dir=${lenderGit}`, 'update-ref', pin, sha], { env: GIT_ENV });
        pinned.push([lenderGit, pin]);
      }
    }
  });
  return () => {
    for (const [g, pin] of pinned) {
      execFileSync('git', [`--git-dir=${g}`, 'update-ref', '-d', pin], { env: GIT_ENV });
      rmSync(join(g, 'logs', pin), { force: true });
    }
    for (const g of new Set(pinned.map(([g]) => g))) {
      rmSync(join(g, 'logs/refs/borrowed'), { recursive: true, force: true });
      rmSync(join(g, 'refs/borrowed'), { recursive: true, force: true });
    }
  };
}

const inGitDir = (rel) => rel.split('/').some((part, i, parts) => i < parts.length - 1 && (part === '.git' || (i === 0 && part.endsWith('.git'))));
const isObjectStore = (rel) => /(^|\/)objects\//.test(rel);
const alternatesGitDir = (rel) => /^(.*)\/objects\/info\/alternates$/.exec(rel)?.[1];
const rewritable = (rel) => basename(rel) === '.git' || (inGitDir(rel) && !isObjectStore(rel) && basename(rel) !== 'index');

/** The bundle of the fixture folder `dir`, its repositories called `name` in the demo. */
export function packFixture(dir, name, { inPlace = false } = {}) {
  if (!/^[A-Za-z0-9_.-]+$/.test(name) || name === '.' || name === '..') throw new Error(`bad demo bundle name: ${name}`);
  const src = realpathSync(dir);
  const work = inPlace ? src : join(realpathSync(mkdtempSync(join(tmpdir(), 'gitbolt-pack-'))), 'fixture');
  try {
    if (!inPlace) cpSync(src, work, { recursive: true, verbatimSymlinks: true });
    const gits = gitDirs(work);
    const unpin = pinBorrowed(work, src, gits);
    try {
      for (const g of gits) compact(g);
    } finally {
      unpin();
    }
    const pieces = readdirSync(work).filter((p) => p !== MARKER);
    const files = [];
    for (const { rel, path, st } of walk(work, work)) {
      if (rel === MARKER || /(^|\/)hooks\/[^/]+\.sample$/.test(rel)) continue;
      if (st.isSymbolicLink()) {
        files.push({ path: rel, mode: 0o120000, data: Buffer.from(readlinkSync(path), 'utf8') });
        continue;
      }
      let data = readFileSync(path);
      if (inGitDir(rel) && basename(rel) === 'index') {
        const v = indexVersion(data);
        if (v !== 2) throw new Error(`${rel}: index version ${v}; the demo (isomorphic-git) reads only version 2`);
        data = scrubIndexStat(data);
      }
      // The harness pins fast-import's committer and date; this is a guard that also zeroes the offset, so a stray local time zone can't leak into a bundle.
      if (inGitDir(rel) && /(^|\/)logs\//.test(rel) && data.includes('\tfast-import')) data = Buffer.from(data.toString('utf8').replace(/> \d+ [+-]\d{4}(\tfast-import)/g, '> 1700000000 +0000$1'), 'utf8');
      const altDir = alternatesGitDir(rel);
      if (altDir !== undefined) data = Buffer.from(rewriteAlternates(data.toString('utf8'), altDir, src, name, pieces), 'utf8');
      else if (rewritable(rel) && data.length < REWRITE_MAX && data.includes(`${src}/`)) data = Buffer.from(rewritePaths(data.toString('utf8'), src, name, pieces), 'utf8');
      files.push({ path: rel, mode: st.mode & 0o111 ? 0o100755 : 0o100644, data });
    }
    return encodeBundle(name, files);
  } finally {
    if (!inPlace) rmSync(join(work, '..'), { recursive: true, force: true });
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const inPlace = args[0] === '--in-place';
  const [dir, out] = inPlace ? args.slice(1) : args;
  if (!dir || !out || !out.endsWith('.gbdemo')) {
    console.error('usage: node ui/scripts/pack-demo.mjs [--in-place] <fixtureDir> <out.gbdemo>');
    process.exit(2);
  }
  const bundle = packFixture(dir, basename(out, '.gbdemo'), { inPlace });
  writeFileSync(out, bundle);
  console.log(`${out}: ${bundle.length} bytes`);
}
