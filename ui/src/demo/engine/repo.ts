// One demo repository in the in-memory file system: its files from a bundle, read with
// isomorphic-git (objects, config, status) and with the core's own rules (refs, worktrees,
// stashes), into the graph pipeline's input. Each read names its counterpart in the core.
import { getConfig, getConfigAll, listRemotes, readObject } from 'isomorphic-git';
import type { GraphPayload } from '../../api/gen/GraphPayload';
import type { InProgress } from '../../api/gen/InProgress';
import type { PinSetting } from '../../api/gen/PinSetting';
import type { TagAnnotation } from '../../api/gen/TagAnnotation';
import type { CommitIn } from '../gen/CommitIn';
import type { GraphRequest } from '../gen/GraphRequest';
import type { HeadIn } from '../gen/HeadIn';
import type { ForkFacts } from '../gen/ForkFacts';
import type { RefIn } from '../gen/RefIn';
import type { RefsIn } from '../gen/RefsIn';
import type { StashIn } from '../gen/StashIn';
import type { WipCounts } from '../gen/WipCounts';
import type { WorktreeIn } from '../gen/WorktreeIn';
import type { Bundle } from './bundle';
import { gbError } from './errors';
import { refreshIndexStat } from './gitindex';
import type { GraphLayout } from './layout';
import { type MemFs, normalisePath, parentOf } from './memfs';
import { annotationOf, parseCommitObject, parseTagObject, type TagObject } from './objects';
import { demoPath, demoRoot } from './paths';
import { readCommit } from './read/commitText';
import { viewOf } from './read/seam';
import { parseGitmodules } from './read/worktree';
import { midOperation, readInProgress, showsHeadMessage } from './write/inProgress';
import { statusEntries, summarize } from './write/status';
import { parseReflog } from './reflog';
import { compareBytes, readRefFiles, type RefFile } from './refs';
import { hostKind, mismatchedUpstream, parseRemoteUrl, remoteFor, remoteId } from './remotes';

export const DEFAULT_COMMIT_LIMIT = 2000;
const COMPARE_REFS = 'refs/gitvolt/compare/';
const NULL_OID = '0'.repeat(40);
const OID = /^[0-9a-f]{40}$/;
/** What `git init` makes and a bundle (files only) can't carry: isomorphic-git lists and writes
 * refs and objects there. */
const GIT_SKELETON = ['refs/heads', 'refs/tags', 'objects/info', 'objects/pack'];
/** Where a bundle (paths relative to the fixture folder) can hold a git dir: a piece's `.git`, a
 * bare piece (`origin.git`), and the submodules' under either's `modules/`. */
const GIT_DIR_AT = /^[^/]+(?:\/\.git|\.git)(?:\/modules\/.+)?$/;

/** The repositories by git dir, per fs: what a view of a git dir by path (an origin's alternates,
 * a fetch's) shares its caches with. */
const byGitdir = new WeakMap<MemFs, Map<string, DemoRepo>>();

/** The repository whose git dir is `gitdir` on `fs`, once opened. */
export function repoAt(fs: MemFs, gitdir: string): DemoRepo | undefined {
  return byGitdir.get(fs)?.get(normalisePath(gitdir));
}

export const isClean = (c: WipCounts): boolean => c.modified + c.added + c.deleted + c.renamed + c.conflicted === 0;

export class DemoRepo {
  /** Given when the UI opens it (`openRepo`), as the core's handles; 0 before. */
  id = 0;
  readonly name: string;
  /** The main worktree, `/demo/<name>`. */
  readonly path: string;
  readonly gitdir: string;
  /** Every commit reachable from a ref, a worktree's HEAD or a stash: the graph's store too. */
  readonly commits = new Map<string, CommitIn>();
  /** The in-memory fs every demo repository lives in. */
  readonly fs: MemFs;
  /** isomorphic-git's cache (pack indexes, parsed objects): pass it to every isomorphic-git call. */
  readonly cache = {};
  private readonly layout: GraphLayout;
  private readonly linkedGitdirs = new Map<string, string>();
  private readonly reachable = new Map<string, Set<string>>();

  private constructor(fs: MemFs, name: string, layout: GraphLayout) {
    this.fs = fs;
    this.name = name;
    this.layout = layout;
    this.path = demoRoot(name, 'repo');
    this.gitdir = `${this.path}/.git`;
  }

  /** The main worktree (`path`'s other name, as isomorphic-git's `dir`). */
  get dir(): string {
    return this.path;
  }

  /** Writes `bundle`'s files where the demo keeps them, with each git dir's skeleton (a bare
   * origin with only packed refs has no `refs/heads`), then opens it and refreshes its worktrees'
   * indexes. */
  static async load(fs: MemFs, bundle: Bundle, layout: GraphLayout): Promise<DemoRepo> {
    const rels = new Set(bundle.files.map((f) => f.path));
    for (const f of bundle.files) {
      const p = demoPath(bundle.name, f.path);
      fs.mkdirpSync(parentOf(p));
      if ((f.mode & 0o170000) === 0o120000) fs.symlinkSync(new TextDecoder().decode(f.data), p);
      else fs.writeFileSync(p, f.data, { mode: f.mode & 0o777 });
    }
    // A bundle holds no empty folders, but a checkout leaves one at each submodule path (an
    // uninitialised one is just that folder, not a deletion).
    for (const f of bundle.files) {
      if (!/(^|\/)\.gitmodules$/.test(f.path)) continue;
      const base = f.path.slice(0, -'.gitmodules'.length);
      for (const m of parseGitmodules(new TextDecoder().decode(f.data))) fs.mkdirpSync(demoPath(bundle.name, `${base}${m.path}`));
    }
    // A git dir: a HEAD beside a config where git dirs live (a tracked folder holding files of
    // those names isn't one). A linked worktree's (its `commondir`) has no refs of its own.
    for (const rel of rels) {
      if (!rel.endsWith('/HEAD')) continue;
      const dir = rel.slice(0, -5);
      if (!GIT_DIR_AT.test(dir) || !rels.has(`${dir}/config`) || rels.has(`${dir}/commondir`)) continue;
      for (const sub of GIT_SKELETON) fs.mkdirpSync(demoPath(bundle.name, `${dir}/${sub}`));
    }
    const repo = await DemoRepo.open(fs, bundle.name, layout);
    await repo.refreshIndexes();
    return repo;
  }

  /** The packer zeroes each index's stat data: this writes this fs's into each worktree's index
   * once, for the entries whose file is unchanged, so status hashes only what changed. Without
   * WebCrypto (an insecure context) they stay as bundled, and every status (`refresh: false`)
   * then reads and hashes every tracked file, on every call. */
  private async refreshIndexes(): Promise<void> {
    if (globalThis.crypto?.subtle === undefined) return;
    for (const w of await this.worktrees()) {
      const own = w.isMain ? this.gitdir : this.linkedGitdirs.get(w.path);
      if (!w.bare && !w.prunable && own !== undefined) await refreshIndexStat(this.fs, w.path, `${own}/index`);
    }
  }

  /** The repository already at `/demo/<name>` in `fs` (a bundle's, or one a test built with
   * isomorphic-git), its commits read. */
  static async open(fs: MemFs, name: string, layout: GraphLayout): Promise<DemoRepo> {
    const repo = new DemoRepo(fs, name, layout);
    let repos = byGitdir.get(fs);
    if (!repos) byGitdir.set(fs, (repos = new Map()));
    repos.set(repo.gitdir, repo);
    const files = repo.refFiles();
    const refs = repo.refMap(files);
    const tips = new Set<string>();
    for (const f of files) {
      const oid = f.symref === null ? f.oid : repo.resolveRef(refs, f.full);
      const commit = oid === null ? null : await repo.peelToCommit(oid);
      if (commit) tips.add(commit);
    }
    for (const w of await repo.worktrees(refs)) if (w.head) tips.add(w.head);
    for (const s of repo.stashes()) tips.add(s.id);
    await repo.addCommits([...tips]);
    return repo;
  }

  /** Reads every commit reachable from `tips` not read yet, into the store and the graph's. */
  async addCommits(tips: string[]): Promise<void> {
    const queue = [...tips];
    const fresh: CommitIn[] = [];
    for (let id = queue.pop(); id !== undefined; id = queue.pop()) {
      if (this.commits.has(id)) continue;
      const o = await this.readRaw(id);
      if (!o || o.type !== 'commit') continue;
      const c = parseCommitObject(id, o.object);
      this.commits.set(id, c);
      fresh.push(c);
      for (const p of c.parents) if (!this.commits.has(p)) queue.push(p);
    }
    if (fresh.length) this.layout.addCommits(fresh);
  }

  private async readRaw(oid: string): Promise<{ type: string; object: Uint8Array } | null> {
    try {
      const r = await readObject({ fs: this.fs, gitdir: this.gitdir, oid, format: 'content', cache: this.cache });
      return { type: r.type, object: r.object as Uint8Array };
    } catch {
      return null;
    }
  }

  /** The commit `oid` peels to through tags; null for another kind, or a missing object. */
  async peelToCommit(oid: string): Promise<string | null> {
    let cur = oid;
    for (let i = 0; i < 10; i++) {
      const o = await this.readRaw(cur);
      if (!o || (o.type !== 'commit' && o.type !== 'tag')) return null;
      if (o.type === 'commit') return cur;
      cur = parseTagObject(o.object).object;
    }
    return null;
  }

  /** A ref's own object as refs::read_tag reads it: the commit it peels to, and the tag object
   * when it's an annotated tag. Null when it doesn't peel to a commit. */
  async refTarget(oid: string): Promise<{ commit: string; tag: TagObject | null } | null> {
    const o = await this.readRaw(oid);
    if (!o) return null;
    if (o.type === 'commit') return { commit: oid, tag: null };
    if (o.type !== 'tag') return null;
    const tag = parseTagObject(o.object);
    const commit = await this.peelToCommit(tag.object);
    return commit === null ? null : { commit, tag };
  }

  refFiles(): RefFile[] {
    return readRefFiles(this.fs, this.gitdir);
  }

  refMap(files: RefFile[] = this.refFiles()): Map<string, RefFile> {
    return new Map(files.map((f) => [f.full, f]));
  }

  /** What the ref `name` resolves to through symbolic refs; null when it doesn't exist. */
  resolveRef(refs: Map<string, RefFile>, name: string): string | null {
    let cur = name;
    for (let i = 0; i < 5; i++) {
      const r = refs.get(cur);
      if (!r) return null;
      if (r.symref === null) return r.oid;
      cur = r.symref;
    }
    return null;
  }

  /** A HEAD file: the commit it resolves to (null while unborn) and, when symbolic, the ref it
   * ends at (worktree::head_of). */
  headOf(file: string, refs: Map<string, RefFile>): { head: string | null; branch: string | null } {
    let text: string;
    try {
      text = (this.fs.readFileSync(file, 'utf8') as string).trim();
    } catch {
      return { head: null, branch: null };
    }
    if (!text.startsWith('ref:')) {
      const oid = text.toLowerCase();
      return { head: OID.test(oid) && oid !== NULL_OID ? oid : null, branch: null };
    }
    let name = text.slice(4).trim();
    for (let i = 0; i < 5; i++) {
      const r = refs.get(name);
      if (!r) return { head: null, branch: name };
      if (r.symref === null) return { head: r.oid !== null && r.oid !== NULL_OID ? r.oid : null, branch: name };
      name = r.symref;
    }
    return { head: null, branch: name };
  }

  /** The repository's own HEAD, the main worktree's (refs::read_head). */
  head(refs: Map<string, RefFile>): HeadIn {
    let text = '';
    try {
      text = (this.fs.readFileSync(`${this.gitdir}/HEAD`, 'utf8') as string).trim();
    } catch {
      // no HEAD: reads as unborn below
    }
    if (text.startsWith('ref:')) {
      const branch = text.slice(4).trim();
      const target = this.resolveRef(refs, branch);
      return { branch, target, detached: false, unborn: target === null };
    }
    const direct = OID.test(text) ? text : null;
    return { branch: null, target: direct, detached: direct !== null, unborn: direct === null };
  }

  async config(path: string): Promise<string | null> {
    const v: unknown = await getConfig({ fs: this.fs, gitdir: this.gitdir, path });
    return v === undefined || v === null ? null : String(v);
  }

  async configAll(path: string): Promise<string[]> {
    const values: unknown[] = await getConfigAll({ fs: this.fs, gitdir: this.gitdir, path });
    return values.filter((v) => v !== undefined && v !== null).map(String);
  }

  /** The remotes and their fetch URLs, in the config's order. */
  async remotes(): Promise<{ name: string; url: string | null }[]> {
    return (await listRemotes({ fs: this.fs, gitdir: this.gitdir })).map((r) => ({ name: r.remote, url: r.url ?? null }));
  }

  /** `stash@{n}`, newest first, from the stash's reflog (refs::read_stashes). */
  stashes(): StashIn[] {
    let text: string;
    try {
      text = this.fs.readFileSync(`${this.gitdir}/logs/refs/stash`, 'utf8') as string;
    } catch {
      return [];
    }
    return parseReflog(text).map((e, index) => ({ index, id: e.new, message: e.message, time: e.time }));
  }

  /** The main worktree, then each `worktrees/<id>` whose `gitdir` names a checkout, by path
   * (worktree::read_worktrees). The demo's paths are canonical already. */
  async worktrees(refs: Map<string, RefFile> = this.refMap()): Promise<WorktreeIn[]> {
    const bare = (await this.config('core.bare')) === 'true';
    const mainPath = bare ? this.gitdir : this.path;
    const main = bare ? { head: null, branch: null } : this.headOf(`${this.gitdir}/HEAD`, refs);
    const linked: WorktreeIn[] = [];
    let ids: string[] = [];
    try {
      ids = this.fs.readdirSync(`${this.gitdir}/worktrees`);
    } catch {
      // no linked worktrees
    }
    for (const id of ids) {
      const dir = `${this.gitdir}/worktrees/${id}`;
      let dotGit: string;
      try {
        dotGit = (this.fs.readFileSync(`${dir}/gitdir`, 'utf8') as string).trimEnd();
      } catch {
        continue;
      }
      if (!dotGit) continue;
      const abs = normalisePath(dotGit.startsWith('/') ? dotGit : `${dir}/${dotGit}`);
      const path = abs.endsWith('/.git') ? abs.slice(0, -5) : abs;
      const locked = this.fs.existsSync(`${dir}/locked`, false);
      const { head, branch } = this.headOf(`${dir}/HEAD`, refs);
      this.linkedGitdirs.set(path, dir);
      linked.push({ path, canonical: path, head, branch, isMain: false, bare: false, prunable: !locked && !this.fs.existsSync(abs, false), locked });
    }
    linked.sort((a, b) => compareBytes(a.path, b.path));
    return [{ path: mainPath, canonical: mainPath, head: main.head, branch: main.branch, isMain: true, bare, prunable: false, locked: false }, ...linked];
  }

  /** `w`'s WIP counts, from the write layer's status (own HEAD and index; conflicts and staged
   * renames counted). A read never writes the index. */
  async wipCounts(w: WorktreeIn): Promise<WipCounts> {
    if (!w.isMain && !this.linkedGitdirs.has(w.path)) throw gbError('InvalidInput', `${w.path} is not a worktree of this repository`);
    return summarize(await statusEntries(viewOf(this), w.path));
  }

  /** A local branch's upstream as `branch.<name>.remote`/`merge` name it (refs::upstream_parts). */
  async upstreamParts(branch: string): Promise<{ remote: string; name: string } | null> {
    const remote = await this.config(`branch.${branch}.remote`);
    const merge = await this.config(`branch.${branch}.merge`);
    if (remote === null || merge === null || remote === '.' || !merge.startsWith('refs/heads/')) return null;
    return { remote, name: merge.slice(11) };
  }

  /** The refs as the core reads them for the graph (refs::read_refs). */
  async graphRefs(files: RefFile[], refs: Map<string, RefFile>): Promise<RefsIn> {
    const remotes = await this.remotes();
    const names = remotes.map((r) => r.name);
    const out: RefsIn = { head: this.head(refs), refs: [], remoteHeads: {}, remoteHosts: {}, remoteHostNames: {}, stashes: this.stashes(), pushRemotes: {}, remoteIds: {}, compareHeads: [] };
    for (const r of remotes) {
      const host = r.url === null ? null : (parseRemoteUrl(r.url)?.host ?? null);
      out.remoteHosts[r.name] = host === null ? 'generic' : hostKind(host);
      if (host !== null) out.remoteHostNames[r.name] = host;
      if (r.url !== null) out.remoteIds[r.name] = remoteId(r.url);
    }
    const pushDefault = await this.config('remote.pushDefault');
    for (const f of files) {
      if (f.symref !== null) {
        const m = /^refs\/remotes\/(.+)\/HEAD$/.exec(f.full);
        if (m) out.remoteHeads[m[1]] = f.symref;
        continue;
      }
      if (f.oid === null) continue;
      let kind: RefIn['kind'];
      let short: string;
      if (f.full.startsWith('refs/heads/')) {
        kind = { type: 'local' };
        short = f.full.slice('refs/heads/'.length);
      } else if (f.full.startsWith('refs/remotes/')) {
        short = f.full.slice('refs/remotes/'.length);
        const remote = remoteFor(short, names);
        if (remote === null) continue;
        kind = { type: 'remote', remote };
      } else if (f.full.startsWith('refs/tags/')) {
        kind = { type: 'tag' };
        short = f.full.slice('refs/tags/'.length);
      } else {
        if (f.full.startsWith(COMPARE_REFS)) {
          const c = await this.peelToCommit(f.oid);
          if (c) out.compareHeads.push(c);
        }
        continue;
      }
      const t = await this.refTarget(f.oid);
      if (!t) continue;
      const annotation: TagAnnotation | null = kind.type === 'tag' && t.tag ? annotationOf(t.tag) : null;
      let upstream: string | null = null;
      let upstreamMismatch: string | null = null;
      if (kind.type === 'local') {
        const parts = await this.upstreamParts(short);
        if (parts) {
          upstream = `refs/remotes/${parts.remote}/${parts.name}`;
          upstreamMismatch = mismatchedUpstream(short, parts.remote, parts.name);
        }
        const push = (await this.config(`branch.${short}.pushRemote`)) ?? pushDefault;
        if (push !== null) out.pushRemotes[f.full] = push;
      }
      out.refs.push({ fullName: f.full, shortName: short, kind, target: t.commit, upstream, upstreamMismatch, annotation });
    }
    return out;
  }

  /** The `graph` request (api.rs's Graph arm). */
  /** `forks`: the forge's cached facts on the remotes' projects (`ForgeHub::cached_forks`); none without a forge. */
  async graph(o: { limit: number | null; pin?: PinSetting; active?: string; forks?: ForkFacts }): Promise<GraphPayload> {
    return this.layout.build(await this.graphRequest(o));
  }

  /** The order the graph's walk collects commits in (before its topological fix-up): what find's
   * `locateCommit` sizes a window by (the core's `walk_by_date` over `graph_tips`). */
  async walkOrder(limit: number): Promise<string[]> {
    return this.layout.walkOrder(await this.graphRequest({ limit }));
  }

  /** This repository's input to the graph pipeline. */
  private async graphRequest(o: { limit: number | null; pin?: PinSetting; active?: string; forks?: ForkFacts }): Promise<GraphRequest> {
    const files = this.refFiles();
    const refs = this.refMap(files);
    const worktrees = await this.worktrees(refs);
    const active = o.active === undefined ? null : o.active.startsWith('/') ? normalisePath(o.active) : o.active;
    if (active !== null && !worktrees.some((w) => !w.bare && !w.prunable && w.canonical === active)) throw gbError('InvalidInput', `${o.active} is not a worktree of this repository`);
    const wip: [number, WipCounts][] = [];
    const inProgress: Record<string, InProgress> = {};
    for (const [i, w] of worktrees.entries()) {
      if (w.bare || w.prunable || !this.fs.existsSync(w.path)) continue;
      const counts = await this.wipCounts(w); // validates the worktree
      const own = w.isMain ? this.gitdir : (this.linkedGitdirs.get(w.path) ?? this.gitdir);
      // An edit stop shows HEAD's message.
      const headMessage = showsHeadMessage(this.fs, own) && w.head ? (await readCommit(viewOf(this), w.head)).rawMessage : null;
      const state = readInProgress(this.fs, own, headMessage);
      if (state) inProgress[w.path] = state;
      // A clean worktree has no WIP row unless it's mid-operation: its commit panel holds Continue and Abort.
      if (!isClean(counts) || midOperation(this.fs, own)) wip.push([i, counts]);
    }
    return {
      refs: await this.graphRefs(files, refs),
      worktrees,
      wip,
      inProgress,
      workdir: this.path,
      active,
      pinnedRef: o.pin?.kind === 'ref' ? o.pin.name : null,
      noPin: o.pin?.kind === 'off',
      forks: o.forks ?? { parents: {}, roots: [], covered: [] },
      limit: o.limit ?? DEFAULT_COMMIT_LIMIT,
    };
  }

  /** Every commit reachable from `oid`, itself included (commits never change: kept). */
  reach(oid: string): Set<string> {
    const hit = this.reachable.get(oid);
    if (hit) return hit;
    const seen = new Set<string>();
    const queue = [oid];
    for (let id = queue.pop(); id !== undefined; id = queue.pop()) {
      if (seen.has(id)) continue;
      const c = this.commits.get(id);
      if (!c) continue;
      seen.add(id);
      queue.push(...c.parents);
    }
    this.reachable.set(oid, seen);
    return seen;
  }

  /** `git rev-list --left-right --count ours...theirs`. */
  aheadBehind(ours: string, theirs: string): [number, number] {
    const a = this.reach(ours);
    const b = this.reach(theirs);
    let ahead = 0;
    let behind = 0;
    for (const x of a) if (!b.has(x)) ahead++;
    for (const x of b) if (!a.has(x)) behind++;
    return [ahead, behind];
  }
}
