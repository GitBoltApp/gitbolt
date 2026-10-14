// git stash as git 2.53 does it (observed from the binary, never its source): the W/I/U commits
// written by hand so their ids are git's, the list as refs/stash's reflog, and apply's order of
// steps (index part, untracked files, then the tree merge), side effects of a refusal included.
// Not as git does: paths are literal (git's are pathspecs, globs included); the abbreviated id in
// the messages is always 7 digits (git lengthens it in a large repository); the index part's hunks
// come from 1b's Myers diff, so among repeated lines one may sit where git's wouldn't.
import type { GbError } from '../../../api/gen/GbError';
import { gbError, gitFailure } from '../errors';
import { parentOf } from '../memfs';
import { compareBytewise, isBinaryHead, latin1 } from '../read/bytes';
import { AttrReader, markerSizeOf } from '../read/attributes';
import { gitSubject, readCommit } from '../read/commitText';
import type { IndexEntry, IndexStat } from '../read/indexFile';
import { diffLines, splitLines, unifiedHunks, type DiffHunk } from '../read/lineDiff';
import { fail } from '../read/seam';
import { diffTrees, listFiles, MODE_GITLINK, readBlobBytes, type FileEntry, type TreeChange } from '../read/trees';
import { checkoutEntry, fileAt, kind, readFileState, removeWorktreePath, repoWithin, throughLink } from './files';
import { keepStat, loadIndex, saveIndex, stage0Of, unmergedOf } from './index';
import { applyMerge, mergeTrees } from './mergeTrees';
import { worktreeProblems } from './mergeRun';
import { hardReset, mixedReset, refusal } from './move';
import { writeBlobBytes, writeCommitObject, writeIndexTree, writeTreeOf } from './objects';
import { latin1Bytes } from './patchApply';
import { casRefs, readHead, readRef, ZERO_OID } from './refs';
import type { WriteWt } from './seam';
import { othersUnder } from './snapshot';
import { statusEntries } from './status';

export const STASH_REF = 'refs/stash';
const LOG = (wt: WriteWt) => `${wt.demo.gitdir}/logs/${STASH_REF}`;

export function userMessage(subject: string): string {
  for (const prefix of ['On ', 'WIP on ']) {
    if (!subject.startsWith(prefix)) continue;
    const at = subject.indexOf(': ', prefix.length);
    if (at >= 0) return subject.slice(at + 2);
  }
  return subject;
}

/** git's whitespace here is space, tab, LF and CR (a vertical tab or form feed stays). */
export const reflogMessage = (text: string): string => text.replace(/[ \t\n\r]+/g, ' ').replace(/^ | $/g, '');

export interface StashEntry {
  oid: string;
  subject: string;
}

export function stashList(wt: WriteWt): StashEntry[] {
  return wt.demo.stashes().map((s) => ({ oid: s.id, subject: s.message }));
}

export function subjectOf(wt: WriteWt, oid: string): string {
  return stashList(wt).find((s) => s.oid === oid)?.subject ?? fail('NotFound', 'That stash is gone');
}

/** The reflog's lines, oldest first, as text. */
function logLines(wt: WriteWt): string[] {
  try {
    return (wt.fs.readFileSync(LOG(wt), 'utf8') as string).split('\n').filter((l) => l !== '');
  } catch {
    return [];
  }
}

function writeList(wt: WriteWt, lines: string[]): void {
  if (lines.length === 0) {
    if (wt.fs.existsSync(LOG(wt), false)) wt.fs.unlinkSync(LOG(wt));
    const now = readRef(wt.demo, STASH_REF);
    if (now !== null) casRefs(wt.demo, [{ name: STASH_REF, old: now, new: null }]);
    return;
  }
  wt.fs.mkdirpSync(parentOf(LOG(wt)));
  wt.fs.writeFileSync(LOG(wt), `${lines.join('\n')}\n`);
  const top = lines[lines.length - 1].split(' ')[1];
  wt.fs.mkdirpSync(`${wt.demo.gitdir}/refs`);
  wt.fs.writeFileSync(`${wt.demo.gitdir}/${STASH_REF}`, `${top}\n`);
}

export function storeStash(wt: WriteWt, ident: string, oid: string, message: string): void {
  const old = readRef(wt.demo, STASH_REF);
  // git logs nothing for a store of the stash already on top.
  if (old === oid) return;
  writeList(wt, [...logLines(wt), `${old ?? ZERO_OID} ${oid} ${ident}\t${reflogMessage(message)}`]);
}

export function dropStash(wt: WriteWt, oid: string): void {
  const lines = logLines(wt);
  // stash@{n} is the n-th line from the end; the newest one naming `oid`.
  const at = lines.map((l) => l.split(' ')[1]).lastIndexOf(oid);
  if (at < 0) fail('NotFound', 'That stash is gone');
  const [dropped] = lines.splice(at, 1);
  if (at < lines.length) {
    const next = lines[at].split(' ');
    next[0] = dropped.split(' ')[0];
    lines[at] = next.join(' ');
  }
  writeList(wt, lines);
}

export type Untracked = 'none' | 'untracked' | 'all';

const inScope = (paths: string[] | null) => (p: string) => paths === null || paths.some((q) => p === q || p.startsWith(`${q}/`));

/** Every file or link the index doesn't have, ignored ones too (`ls-files --others`). */
function others(wt: WriteWt, indexed: Set<string>): string[] {
  const out: string[] = [];
  for (const name of wt.fs.readdirSync(wt.root) as string[]) {
    if (name === '.git' || indexed.has(name)) continue;
    if (kind(wt, `${wt.root}/${name}`) === 'dir') out.push(...othersUnder(wt, name, indexed));
    else out.push(name);
  }
  return out.sort(compareBytewise);
}

/** `git clean -d`'s folders: each one holding no file at any depth goes (a submodule's stays). */
function removeEmptyFolders(wt: WriteWt, indexed: Set<string>): void {
  const walk = (rel: string): boolean => {
    let empty = true;
    for (const name of wt.fs.readdirSync(rel === '' ? wt.root : `${wt.root}/${rel}`) as string[]) {
      const p = rel === '' ? name : `${rel}/${name}`;
      if (p === '.git' || kind(wt, `${wt.root}/${p}`) !== 'dir' || indexed.has(p) || !walk(p)) empty = false;
    }
    if (empty && rel !== '') wt.fs.rmdirSync(`${wt.root}/${rel}`);
    return empty;
  };
  walk('');
}

const NO_INITIAL = 'You do not have the initial commit yet';

export async function pushStash(wt: WriteWt, ident: string, message: string, o: { untracked: Untracked; paths: string[] | null }): Promise<StashEntry | null> {
  const head = readHead(wt);
  if (head.oid === null) throw gitFailure(NO_INITIAL, `${NO_INITIAL}\n`);
  const entries = await loadIndex(wt);
  // git's own words; it prints the `<path>: needs merge` lines on stdout.
  if (unmergedOf(entries).size > 0) throw gitFailure('could not write index', 'error: could not write index\n');
  const scope = inScope(o.paths);
  const status = await statusEntries(wt.repo, wt.root);
  const tracked = status.filter((s) => s.kind !== 'untracked' && (scope(s.path) || (s.origPath !== null && scope(s.origPath))));
  const indexed = new Set(entries.map((e) => e.path));
  const untracked =
    o.untracked === 'none' ? [] : o.untracked === 'all' ? others(wt, indexed).filter(scope) : status.filter((s) => s.kind === 'untracked' && scope(s.path)).map((s) => s.path);
  // Nothing to stash: no change in scope (an intent-to-add entry whose file is gone is one).
  if (tracked.length === 0 && untracked.length === 0) return null;
  // An intent-to-add entry whose file is there stops git before it writes anything (in scope or not).
  const blocked = entries.find((e) => e.intentToAdd && fileAt(wt, e.path) !== null);
  if (blocked) {
    const m = `Entry '${blocked.path}' not uptodate. Cannot merge.`;
    throw gitFailure(m, `error: ${m}\nCannot save the current worktree state\n`);
  }
  const index = stage0Of(entries.filter((e) => !e.intentToAdd));
  const headFiles = await listFiles(wt.repo, head.oid);
  // W: the index, with the paths in scope that HEAD or the index has taken from the worktree; an
  // addition whose file is gone keeps its staged blob, a staged deletion whose file is there comes
  // back, as git's do. A submodule keeps its entry.
  const changed = new Set(status.filter((s) => s.kind !== 'untracked' && s.worktree !== '.').map((s) => s.path));
  const w = new Map([...index].map(([p, e]) => [p, { path: p, mode: e.mode, oid: e.oid }]));
  for (const p of new Set([...headFiles.keys(), ...index.keys()])) {
    const e = index.get(p);
    if (!scope(p) || e?.mode === MODE_GITLINK || (e && !changed.has(p))) continue;
    const f = fileAt(wt, p);
    if (f !== null) w.set(p, { path: p, mode: f.mode, oid: await writeBlobBytes(wt.repo, f.bytes) });
    else if (headFiles.has(p)) w.delete(p);
  }
  const c = await readCommit(wt.repo, head.oid);
  const branch = head.branch ?? '(no branch)';
  const on = `${branch}: ${head.oid.slice(0, 7)} ${gitSubject(c.rawMessage)}`;
  const i = await writeCommitObject(wt.repo, { tree: await writeIndexTree(wt.repo, entries), parents: [head.oid], author: ident, committer: ident, message: `index on ${on}\n` });
  const parents = [head.oid, i];
  // git 2.53 writes the untracked files' commit whenever -u or -a is given, with none in it too.
  if (o.untracked !== 'none') {
    const files = [];
    for (const p of untracked) {
      const f = readFileState(wt, p)!;
      files.push({ path: p, mode: f.mode, oid: await writeBlobBytes(wt.repo, f.bytes) });
    }
    parents.push(await writeCommitObject(wt.repo, { tree: await writeTreeOf(wt.repo, files), parents: [], author: ident, committer: ident, message: `untracked files on ${on}\n` }));
  }
  const full = message === '' ? `WIP on ${on}` : `On ${branch}: ${message}`;
  const oid = await writeCommitObject(wt.repo, { tree: await writeTreeOf(wt.repo, w.values()), parents, author: ident, committer: ident, message: full });
  // A multi-line message lists by its first line (the core's relist: a drop and a store again).
  const first = message.split('\n')[0].replace(/\r$/, '').trim();
  const subject = reflogMessage(message.trimEnd().includes('\n') ? `On ${branch}: ${first}` : full);
  storeStash(wt, ident, oid, subject);
  // The untracked files go first: one HEAD has (its entry removed from the index) comes back.
  // Their folders go when that empties them; without paths, every empty folder (git's `clean -d`).
  for (const p of untracked) removeWorktreePath(wt, p);
  if (o.paths === null) {
    if (o.untracked !== 'none') removeEmptyFolders(wt, indexed);
    await hardReset(wt, head.oid);
  } else {
    // Only the paths in scope go back to HEAD, in the index and the worktree.
    await mixedReset(wt, head.oid, o.paths);
    const stats = new Map<string, IndexStat>();
    for (const p of new Set(tracked.flatMap((s) => [s.path, ...(s.origPath === null ? [] : [s.origPath])]))) {
      if (!scope(p)) continue;
      const e = headFiles.get(p);
      if (!e) removeWorktreePath(wt, p);
      else {
        const st = await checkoutEntry(wt, p, e);
        if (st) stats.set(p, st);
      }
    }
    await saveIndex(wt, (await loadIndex(wt)).map((e) => (stats.has(e.path) && e.stage === 0 ? { ...e, stat: stats.get(e.path)! } : e)));
  }
  return { oid, subject };
}

/** One text patch onto `target` as `git apply` places it, no fuzz: each hunk's old lines found at
 *  their place or the nearest offset (forward first), in any order; a hunk from the first line
 *  only at the start, one with no context after it only at the end, none over lines an earlier hunk
 *  wrote. Null when a hunk doesn't apply. */
function applyHunks(target: string[], hunks: DiffHunk[]): string[] | null {
  const out = [...target];
  // The lines an earlier hunk wrote (its context too): a later one may not match over them.
  const patched = target.map(() => false);
  let shift = 0;
  for (const h of hunks) {
    const pre = h.lines.filter((l) => l.kind !== 'add').map((l) => l.text);
    const post = h.lines.filter((l) => l.kind !== 'del').map((l) => l.text);
    const atStart = h.oldStart <= 1;
    const atEnd = h.lines[h.lines.length - 1]?.kind !== 'context';
    const want = Math.max(0, h.oldStart - 1 + shift);
    const fits = (at: number) =>
      at >= 0 && at + pre.length <= out.length && (!atStart || at === 0) && (!atEnd || at + pre.length === out.length) && pre.every((l, k) => out[at + k] === l && !patched[at + k]);
    let at = -1;
    for (let d = 0; at < 0 && (want - d >= 0 || want + d <= out.length); d++) {
      if (fits(want + d)) at = want + d;
      else if (fits(want - d)) at = want - d;
    }
    if (at < 0) return null;
    out.splice(at, pre.length, ...post);
    patched.splice(at, pre.length, ...post.map(() => true));
    shift += post.length - pre.length + (at - want);
  }
  return out;
}

/** One path's change `from` → `to` (git's HEAD→index patch: an addition, a deletion, or a text
 *  patch with 3 lines of context) applied onto `onto` as `git apply --cached` would; null when it
 *  doesn't apply. The autostash's prediction (Task 20) asks the same of the target's entry. */
export async function patchEntry(wt: WriteWt, from: FileEntry | null, to: FileEntry | null, onto: FileEntry | null): Promise<{ entry: FileEntry | null } | null> {
  const same = (a: FileEntry | null, b: FileEntry | null) => (a === null ? b === null : b !== null && a.oid === b.oid && a.mode === b.mode);
  if (from === null) return onto === null ? { entry: to } : null;
  if (to === null) return same(from, onto) ? { entry: null } : null;
  if (same(from, onto)) return { entry: to };
  if (onto === null || from.mode === MODE_GITLINK) return null;
  const [ob, nb, tb] = [await readBlobBytes(wt.repo, from.oid), await readBlobBytes(wt.repo, to.oid), await readBlobBytes(wt.repo, onto.oid)];
  if (isBinaryHead(ob) || isBinaryHead(nb) || isBinaryHead(tb)) return null;
  const [ol, nl] = [splitLines(latin1(ob)), splitLines(latin1(nb))];
  const applied = applyHunks(splitLines(latin1(tb)), unifiedHunks(ol, nl, diffLines(ol, nl)));
  if (applied === null) return null;
  return { entry: { mode: from.mode === to.mode ? onto.mode : to.mode, oid: await writeBlobBytes(wt.repo, latin1Bytes(applied.join(''))) } };
}

/** The stash's index change (B → I) onto `entries`; null when it doesn't apply. */
async function indexPatch(wt: WriteWt, entries: IndexEntry[], b: string, i: string): Promise<IndexEntry[] | null> {
  const now = stage0Of(entries);
  let next = [...entries];
  for (const c of await diffTrees(wt.repo, b, i)) {
    const cur = now.get(c.path) ?? null;
    const r = await patchEntry(wt, c.old, c.new, cur && { oid: cur.oid, mode: cur.mode });
    if (r === null) return null;
    next = next.filter((x) => x.path !== c.path);
    if (r.entry) next.push(keepStat(now, { path: c.path, mode: r.entry.mode, oid: r.entry.oid, stage: 0 }));
  }
  return next;
}

/** `untracked`: an untracked file of the stash was in the way (git's "already exists, no checkout",
 *  or a file where its folder goes),
 *  so the stash holds the only copy of it; the autostash's restore (Task 20) checks it first. */
export type StashApplied =
  | { kind: 'applied' }
  | { kind: 'indexRefused' }
  | { kind: 'refused'; error: GbError; untracked?: GbError }
  | { kind: 'conflicts'; paths: string[]; untracked?: GbError }
  | { kind: 'partial'; error: GbError };

const OVERWRITTEN = 'Your local changes to the following files would be overwritten by merge:';

/** The first folder of `path` (outermost first) where a file or link stands instead. */
function blockedFolder(wt: WriteWt, path: string): string | null {
  const parts = path.split('/');
  for (let i = 1; i < parts.length; i++) {
    const q = parts.slice(0, i).join('/');
    const k = kind(wt, `${wt.root}/${q}`);
    if (k === null) return null;
    if (k !== 'dir') return q;
  }
  return null;
}

export async function applyStash(wt: WriteWt, oid: string, withIndex: boolean): Promise<StashApplied> {
  const w = await readCommit(wt.repo, oid);
  const [b, i, u] = w.parents;
  const entries = await loadIndex(wt);
  // 1. git's own words; it prints the `<path>: needs merge` lines on stdout.
  if (unmergedOf(entries).size > 0) throw gitFailure('could not write index', 'error: could not write index\n');
  const head = readHead(wt).oid!;
  const headTree = (await readCommit(wt.repo, head)).tree;
  const ours = await writeIndexTree(wt.repo, entries);
  // 2. The index part (`--index`, when the stash has one) must apply to the index as it is.
  const indexPart = withIndex && i !== undefined && (await readCommit(wt.repo, i)).tree !== (await readCommit(wt.repo, b)).tree;
  const patched = indexPart ? await indexPatch(wt, entries.filter((e) => !e.intentToAdd), b, i) : null;
  if (indexPart && patched === null) return { kind: 'indexRefused' };
  // 3. The untracked files; one where something already is stays out. A file or link standing
  //    where one needs a folder stops git there (`fatal: cannot create directory`): the ones
  //    after it aren't written, and the tracked merge still runs.
  const lines: string[] = [];
  if (u !== undefined) {
    for (const [p, e] of await listFiles(wt.repo, u)) {
      const blocked = blockedFolder(wt, p);
      if (blocked !== null) {
        lines.push(`fatal: cannot create directory at '${blocked}': File exists`);
        break;
      }
      if (wt.fs.existsSync(`${wt.root}/${p}`, false)) lines.push(`${p} already exists, no checkout`);
      else await checkoutEntry(wt, p, e);
    }
  }
  const notes = lines.length === 0 ? '' : `${lines.join('\n')}\nerror: could not restore untracked files from stash\n`;
  const unstashed = withIndex ? 'Index was not unstashed.\n' : '';
  // The core's words: git's first line, its kind from the whole stderr.
  const untracked = lines.length === 0 ? null : gitFailure(lines[0].replace(/^fatal: /, ''), notes);
  const withUntracked = untracked === null ? {} : { untracked };
  // 4. git's merge wants the index to hold ours (the index's own tree). With an index part git has
  // reset the index to HEAD by then, so a staged change refuses; an intent-to-add entry always does.
  let staged: string[];
  if (indexPart) {
    await mixedReset(wt, head);
    staged = (await diffTrees(wt.repo, headTree, ours)).map((c) => c.path).sort(compareBytewise);
  } else staged = entries.filter((e) => e.intentToAdd).map((e) => e.path);
  if (staged.length > 0) return { kind: 'refused', error: gitFailure(OVERWRITTEN, `error: ${OVERWRITTEN}\n  ${staged.join(' ')}\n${unstashed}${notes}`), ...withUntracked };
  const attrs = new AttrReader(wt.repo, wt.root);
  const m = await mergeTrees(wt.repo, b, ours, oid, { ours: 'Updated upstream', theirs: 'Stashed changes' }, (p) => markerSizeOf(attrs, p));
  const problems = worktreeProblems(wt, m, await statusEntries(wt.repo, wt.root));
  if (problems.size > 0) {
    const e = refusal('merge', problems, (p) => p);
    return { kind: 'refused', error: gitFailure(e.message, `${e.stderr ?? ''}${unstashed}${notes}`), ...withUntracked };
  }
  // 5. The merge into the worktree and the index.
  await applyMerge(wt, m);
  if (m.conflicts.length > 0) return { kind: 'conflicts', paths: m.conflicts, ...withUntracked };
  const merged = stage0Of(await loadIndex(wt));
  let final: IndexEntry[];
  if (patched !== null) final = patched.map((e) => keepStat(merged, e));
  else {
    const base = await listFiles(wt.repo, b);
    const before = stage0Of(entries);
    final = entries.map((e) => keepStat(merged, e));
    for (const [p, e] of await listFiles(wt.repo, oid)) if (!base.has(p) && !before.has(p)) final.push(keepStat(merged, { path: p, mode: e.mode, oid: e.oid, stage: 0 }));
  }
  await saveIndex(wt, final);
  // 6. An untracked file that was in the way.
  if (untracked !== null) return { kind: 'partial', error: untracked };
  return { kind: 'applied' };
}

// The safety review's C1 and C2 (precheck.rs): a stash that writes a file where a folder holding a
// repository stands would delete that repository whole, so it's refused first.

/** precheck.rs's `repository_in_the_way`: `what` is "stash", "apply" or "pop". */
export const repositoryInTheWay = (path: string, what: string): GbError => gbError('InvalidInput', `${path} is a repository in the way of the ${what}: move it first`);

/** precheck.rs's `repos_at`: the repositories a file written at each of `files` would delete (a `.git`
 *  in the real folder there, or a populated gitlink at or under it), sorted. */
function reposAt(wt: WriteWt, links: Iterable<string>, files: Iterable<string>): string[] {
  const out = new Set<string>();
  const gitlinks = [...links];
  for (const p of files) {
    if (throughLink(wt, p) || kind(wt, `${wt.root}/${p}`) !== 'dir') continue;
    const r = repoWithin(wt, p);
    if (r !== null) {
      out.add(r);
      continue;
    }
    for (const g of gitlinks) {
      if (g !== p && !g.startsWith(`${p}/`)) continue;
      if (!throughLink(wt, g) && kind(wt, `${wt.root}/${g}`) === 'dir' && wt.fs.readdirSync(`${wt.root}/${g}`).length > 0) out.add(g);
    }
  }
  return [...out].sort(compareBytewise);
}

const indexGitlinks = async (wt: WriteWt) => (await loadIndex(wt)).filter((e) => e.mode === MODE_GITLINK).map((e) => e.path);
const isFile = (e: FileEntry | null) => e !== null && e.mode !== MODE_GITLINK;

/** C1 (`stash_push_in_the_way`): the stash's own reset writes HEAD's file at each dirty tracked path
 *  (within `pathspec`) over whatever stands there. */
export async function pushInTheWay(wt: WriteWt, tracked: Set<string>, pathspec: string[] | null): Promise<string[]> {
  const head = readHead(wt).oid;
  if (tracked.size === 0 || head === null) return [];
  const files = await listFiles(wt.repo, head);
  const scope = inScope(pathspec);
  return reposAt(wt, await indexGitlinks(wt), [...tracked].filter((p) => scope(p) && isFile(files.get(p) ?? null)));
}

/** C2 (`stash_apply_in_the_way`): the apply writes the stash's files (W's and I's against its base,
 *  and its untracked ones) over whatever stands there. */
export async function applyInTheWay(wt: WriteWt, oid: string): Promise<string[]> {
  const [b, i, u] = (await readCommit(wt.repo, oid)).parents;
  if (b === undefined) return [];
  const links = await indexGitlinks(wt);
  const files: string[] = [];
  const take = (changes: TreeChange[]) => {
    for (const c of changes) {
      if (isFile(c.new)) files.push(c.path);
      if (c.old?.mode === MODE_GITLINK) links.push(c.path);
    }
  };
  take(await diffTrees(wt.repo, b, oid));
  if (i !== undefined) take(await diffTrees(wt.repo, b, i));
  if (u !== undefined) for (const [p, e] of await listFiles(wt.repo, u)) if (isFile(e)) files.push(p);
  return reposAt(wt, links, files);
}

export async function stashPaths(wt: WriteWt, oid: string): Promise<string[]> {
  const [b, i, u] = (await readCommit(wt.repo, oid)).parents;
  const out = new Set<string>();
  for (const c of await diffTrees(wt.repo, b, oid)) out.add(c.path);
  if (i !== undefined) for (const c of await diffTrees(wt.repo, b, i)) out.add(c.path);
  if (u !== undefined) for (const p of (await listFiles(wt.repo, u)).keys()) out.add(p);
  return [...out].sort(compareBytewise);
}

export async function binaryAmong(wt: WriteWt, oid: string, paths: string[]): Promise<boolean> {
  const b = (await readCommit(wt.repo, oid)).parents[0];
  const [before, after] = [await listFiles(wt.repo, b), await listFiles(wt.repo, oid)];
  for (const p of paths) {
    for (const e of [before.get(p), after.get(p)]) if (e && e.mode !== MODE_GITLINK && isBinaryHead(await readBlobBytes(wt.repo, e.oid))) return true;
  }
  return false;
}
