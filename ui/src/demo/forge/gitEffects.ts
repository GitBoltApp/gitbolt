// The fake GitLab acting on the in-memory origin (plan 4, Decisions): a merge GitLab records
// becomes a real merge (or squash) commit on the origin's target branch; GitLab's Rebase replays
// the source branch onto its target there; a push to a branch with an open MR moves the MR's head
// and runs its pipeline, and the server says GitLab's merge-request lines. The harness's fake forge
// does none of this, so the parity suite turns it off (`DemoForge.gitEffects`).
//
// New objects go into the origin's own store (it borrows the repository's, which a fetch then fills
// from it), written children first: blobs and trees, then commits, then the ref. Commits GitLab
// makes are the merging user's at the demo's clock (UTC); a rebased or squashed commit keeps its
// author line as stored (F3: zone and all).
import * as git from 'isomorphic-git';
import type { DemoContext } from '../context';
import type { MemFs } from '../engine/memfs';
import { demoRoot } from '../engine/paths';
import type { GbError } from '../../api/gen/GbError';
import { isBinaryHead, lossyUtf8, utf8Bytes } from '../engine/read/bytes';
import { readCommit } from '../engine/read/commitText';
import { diffLines, splitLines, unifiedHunks, type DiffHunk } from '../engine/read/lineDiff';
import { renamePairs } from '../engine/read/renames';
import { ancestors, mergeBaseOf } from '../engine/read/revs';
import { viewOf, type ReadRepo } from '../engine/read/seam';
import { diffTrees, MODE_GITLINK, modeType, readBlobBytes } from '../engine/read/trees';
import { compareBytes } from '../engine/refs';
import { readRefFiles } from '../engine/refs';
import type { DemoRepo } from '../engine/repo';
import { netOf } from '../engine/remote/network';
import { borrowingView, hasObject } from '../engine/remote/objects';
import { rangeCommits } from '../engine/seq/range';
import { EMPTY_TREE, replay, treeOf } from '../engine/seq/replay';
import { mergeTrees, rawAuthor, writeCommitObject, type Signature } from '../engine/writeSeam';
import { isDraft, isUnfinished, WEB } from './fakeGitlab';
import type { DemoForge } from './hub';
import type { FakeDiff, FakeMergeRequest } from './seed';

/** How long a pipeline the demo starts runs before it passes. */
export const PIPELINE_MS = 20_000;
/** GitLab's `merge_error` for a rebase that stopped on conflicts. */
export const REBASE_FAILED = 'Rebase failed: Rebase locally, resolve all conflicts, then push the branch.';

interface Origin { repo: DemoRepo; fs: MemFs; gitdir: string; read: ReadRepo; refs: Map<string, string> }

function bundleOf(f: DemoForge, project: string): string | null {
  for (const [name, p] of f.projectOf) if (p === project) return name;
  return null;
}

function projectAt(f: DemoForge, gitdir: string): string | null {
  for (const [name, p] of f.projectOf) if (demoRoot(name, 'origin.git') === gitdir) return p;
  return null;
}

const refsOf = (fs: MemFs, gitdir: string) => new Map(readRefFiles(fs, gitdir).flatMap((r) => (r.oid === null ? [] : [[r.full, r.oid] as [string, string]])));

/** `project`'s origin, when the forge acts on it and its bundle is loaded. */
async function originOf(ctx: DemoContext, f: DemoForge, project: string): Promise<Origin | null> {
  if (!f.gitEffects) return null;
  const name = bundleOf(f, project);
  const repo = name === null ? undefined : ctx.repos.loaded(name);
  if (name === null || !repo) return null;
  const gitdir = demoRoot(name, 'origin.git');
  if (!repo.fs.existsSync(`${gitdir}/HEAD`)) return null;
  return { repo, fs: repo.fs, gitdir, read: await borrowingView(repo.fs, gitdir), refs: refsOf(repo.fs, gitdir) };
}

const mrOf = (f: DemoForge, project: string, iid: number): FakeMergeRequest | undefined => f.fake.seed.mergeRequests.find((m) => m.project === project && m.iid === iid);
/** The MR's source branch is on this project (not a fork's). */
const ownSource = (m: FakeMergeRequest) => (m.sourceProject || m.project) === m.project;

/** A forge user as a commit's author or committer, at the forge's clock. */
function who(f: DemoForge, username: string): Signature {
  const u = f.fake.person(username);
  return { name: u.name, email: u.email ?? `${u.username}@example.com`, timestamp: f.clock(), timezoneOffset: 0 };
}

/** Moves `ref` on the origin from `old` (null: it must not exist) to `next` (null: deleted); false when it moved meanwhile. */
async function moveRef(o: Origin, ref: string, old: string | null, next: string | null): Promise<boolean> {
  if ((refsOf(o.fs, o.gitdir).get(ref) ?? null) !== old) return false;
  if (next === null) await git.deleteRef({ fs: o.fs, gitdir: o.gitdir, ref });
  else await git.writeRef({ fs: o.fs, gitdir: o.gitdir, ref, value: next, force: true });
  return true;
}

/** Every commit reachable from `tip`: the repository's graph when it has `tip`, else a walk of the origin. */
async function historyOf(o: Origin, tip: string): Promise<Set<string>> {
  const known = await ancestors(viewOf(o.repo), tip);
  if (known.has(tip)) return known;
  const seen = new Set<string>();
  const queue = [tip];
  while (queue.length > 0) {
    const at = queue.pop()!;
    if (seen.has(at)) continue;
    seen.add(at);
    queue.push(...(await readCommit(o.read, at)).parents);
  }
  return seen;
}

/** GitLab's merge of `theirs` into `ours`: the tree (null on conflicts) and the merge base. */
async function mergeOf(o: Origin, ours: string, theirs: string, names: { ours: string; theirs: string }) {
  const base = await mergeBaseOf(o.read, ours, theirs);
  const merged = await mergeTrees(o.read, { base: base === null ? null : await treeOf(o.read, base), ours: await treeOf(o.read, ours), theirs: await treeOf(o.read, theirs), labels: { ...names, base: 'base' } });
  return { tree: merged.tree, base };
}

/** The open MR's target tip and head on the origin, when both are there. */
async function sides(o: Origin, m: FakeMergeRequest): Promise<{ target: string; head: string } | null> {
  const target = o.refs.get(`refs/heads/${m.targetBranch}`);
  if (!target || !m.headSha || !(await hasObject(o.fs, o.gitdir, m.headSha))) return null;
  return { target, head: m.headSha };
}

/** git's default hunk heading (checked on the binary): the nearest line above the hunk, on the
 * old side, that starts with a letter, `_` or `$`; trailing whitespace off, at most 80 bytes. */
function heading(old: string[], before: number): string {
  for (let i = before - 1; i >= 0; i--) {
    if (!/^[A-Za-z_$]/.test(old[i])) continue;
    return lossyUtf8(utf8Bytes(old[i].replace(/\s+$/, '')).slice(0, 80));
  }
  return '';
}

/** A hunk as `git diff` prints it: a count of 1 left out, `\ No newline at end of file` after a line without one. */
function hunkText(h: DiffHunk, old: string[]): string {
  const range = (start: number, n: number) => (n === 1 ? `${start}` : `${start},${n}`);
  const head = heading(old, h.oldLines === 0 ? h.oldStart : h.oldStart - 1);
  let out = `@@ -${range(h.oldStart, h.oldLines)} +${range(h.newStart, h.newLines)} @@${head === '' ? '' : ` ${head}`}\n`;
  for (const l of h.lines) out += `${l.kind === 'context' ? ' ' : l.kind === 'del' ? '-' : '+'}${l.text}${l.noEol ? '\n\\ No newline at end of file\n' : ''}`;
  return out;
}

/** A side of a file as `git diff` reads it: a submodule as its commit line; null when binary. */
async function sideText(read: ReadRepo, e: { oid: string; mode: number } | null): Promise<string | null> {
  if (e === null) return '';
  if (modeType(e.mode) === MODE_GITLINK) return `Subproject commit ${e.oid}\n`;
  const bytes = await readBlobBytes(read, e.oid);
  return isBinaryHead(bytes) ? null : lossyUtf8(bytes);
}

/** GitLab's `diffs` of `base..head` (the harness's forge_seed.rs `diffs`: `git diff -M -U3`, each
 * file's text from its first `@@`; empty for a pure rename, a mode change or a binary file), in
 * git's order: by the new path. */
export async function gitlabDiffs(read: ReadRepo, base: string, head: string): Promise<FakeDiff[]> {
  const changes = await diffTrees(read, await treeOf(read, base), await treeOf(read, head));
  const pairs = await renamePairs(read, changes);
  const from = new Set(pairs.map((p) => p.from.path));
  const to = new Set(pairs.map((p) => p.to.path));
  const files = [
    ...changes.filter((c) => !(c.new === null && from.has(c.path)) && !(c.old === null && to.has(c.path))).map((c) => ({ oldPath: c.path, newPath: c.path, old: c.old, new: c.new })),
    ...pairs.map((p) => ({ oldPath: p.from.path, newPath: p.to.path, old: { oid: p.from.oid, mode: p.from.mode }, new: { oid: p.to.oid, mode: p.to.mode } })),
  ].sort((x, y) => compareBytes(x.newPath, y.newPath));
  const out: FakeDiff[] = [];
  for (const file of files) {
    const [a, b] = [await sideText(read, file.old), await sideText(read, file.new)];
    let diff = '';
    if (a !== null && b !== null && a !== b) {
      const [al, bl] = [splitLines(a), splitLines(b)];
      diff = unifiedHunks(al, bl, diffLines(al, bl), 3).map((h) => hunkText(h, al)).join('');
    }
    out.push({ oldPath: file.oldPath, newPath: file.newPath, diff });
  }
  return out;
}

/** The MR's diffs from its base and head as they are now (a push or a rebase moved them). */
async function refreshDiffs(o: Origin, m: FakeMergeRequest): Promise<void> {
  if (m.baseSha === '' || m.headSha === '' || !(await hasObject(o.fs, o.gitdir, m.baseSha)) || !(await hasObject(o.fs, o.gitdir, m.headSha))) return;
  m.diffs = await gitlabDiffs(o.read, m.baseSha, m.headSha);
}

/** Open MRs whose target moved since their base, diffs and conflicts were worked out. As GitLab
 * (its merge status goes back to checking), they're worked out again when the MR is next looked at
 * (`freshen`): a merge into a branch with many open MRs doesn't hold the page while it does them all. */
const stale = new WeakSet<FakeMergeRequest>();

/** MRs whose conflicts the origin showed (not the seed), with the merge status they had. */
const marked = new WeakMap<FakeMergeRequest, string>();

/** GitLab's `has_conflicts` from the origin's trees: set when its head and target conflict, and
 * cleared again only where the origin set it (a seed's story stays as told). */
async function checkConflicts(o: Origin, m: FakeMergeRequest): Promise<void> {
  const s = await sides(o, m);
  if (s === null) return;
  const { tree } = await mergeOf(o, s.target, s.head, { ours: m.targetBranch, theirs: m.sourceBranch });
  if (tree === null && !m.hasConflicts) {
    marked.set(m, m.mergeStatus);
    m.hasConflicts = true;
    if (m.mergeStatus === '' || m.mergeStatus === 'mergeable') m.mergeStatus = 'conflict';
  } else if (tree !== null && marked.has(m)) {
    m.hasConflicts = false;
    if (m.mergeStatus === 'conflict') m.mergeStatus = marked.get(m)!;
    marked.delete(m);
  }
}

/** Before a merge: an MR whose head conflicts with its target on the origin has conflicts, so
 * GitLab refuses to merge it (or to set it to auto-merge). */
export async function conflictsOnOrigin(ctx: DemoContext, f: DemoForge, project: string, iid: number): Promise<void> {
  const m = mrOf(f, project, iid);
  if (m?.state === 'opened' && stale.has(m)) return describeNew(ctx, f, project, iid);
  const o = m?.state === 'opened' ? await originOf(ctx, f, project) : null;
  if (m && o) await checkConflicts(o, m);
}

/** GitLab's merge commit message: its default template, no issues to close. */
export const mergeMessage = (m: FakeMergeRequest): string => `Merge branch '${m.sourceBranch}' into '${m.targetBranch}'\n\n${m.title}\n\nSee merge request ${m.project}!${m.iid}\n`;

/** A merge GitLab just recorded, made on the in-memory origin: the merge (or squash) commit on the
 * target, the source deleted when asked; the MR gets its commit's sha. False when the origin can't
 * take it (its target moved since the check: a conflict, or a ref that moved under the write); true
 * when it's made, or there's nothing to make it on. */
export async function mergeOnOrigin(ctx: DemoContext, f: DemoForge, project: string, iid: number): Promise<boolean> {
  const m = mrOf(f, project, iid);
  if (!m || (m.state !== 'merged' && m.state !== 'locked') || m.mergeCommitSha !== '') return true;
  const o = await originOf(ctx, f, project);
  const s = o === null ? null : await sides(o, m);
  if (o === null || s === null) return true;
  const merger = who(f, f.fake.me);
  let theirs = s.head;
  if (m.squash) {
    // GitLab's squash (its merge method `merge`): the head's tree as one commit on the MR's start
    // (its diff base), by the MR's author; then the merge of that.
    const start = m.baseSha !== '' && (await hasObject(o.fs, o.gitdir, m.baseSha)) ? m.baseSha : await mergeBaseOf(o.read, s.target, s.head);
    theirs = await writeCommitObject(o.read, { tree: await treeOf(o.read, s.head), parents: start === null ? [] : [start], message: m.squashCommitMessage ?? `${m.title}\n`, author: who(f, m.author), committer: merger }, ctx);
  }
  const { tree } = await mergeOf(o, s.target, theirs, { ours: m.targetBranch, theirs: m.sourceBranch });
  if (tree === null) return false;
  const tip = await writeCommitObject(o.read, { tree, parents: [s.target, theirs], message: m.mergeCommitMessage ?? mergeMessage(m), author: merger, committer: merger }, ctx);
  if (!(await moveRef(o, `refs/heads/${m.targetBranch}`, s.target, tip))) return false;
  m.mergeCommitSha = tip;
  if (m.squash) m.squashCommitSha = theirs;
  o.refs.set(`refs/heads/${m.targetBranch}`, tip);
  if (m.removeSourceBranch === true && ownSource(m)) {
    const source = `refs/heads/${m.sourceBranch}`;
    await moveRef(o, source, refsOf(o.fs, o.gitdir).get(source) ?? null, null);
  }
  await branchMoved(ctx, f, project, m.targetBranch, tip);
  return true;
}

/** What recording a merge changes on the fake's MR. */
const recorded = (m: FakeMergeRequest) => ({ state: m.state, autoMergeBy: m.autoMergeBy, squash: m.squash, removeSourceBranch: m.removeSourceBranch, mergeCommitMessage: m.mergeCommitMessage, squashCommitMessage: m.squashCommitMessage, updatedAt: m.updatedAt });

/** The forge's merge (`record`: its PUT, which may refuse) made on the origin too. When the origin
 * can't take it, the MR is as it was before, its conflicts shown, and GitLab refuses (`refused`). */
export async function mergeWith<T>(ctx: DemoContext, f: DemoForge, project: string, iid: number, record: () => T, refused: () => GbError): Promise<T> {
  const m = mrOf(f, project, iid);
  const before = m ? recorded(m) : null;
  const out = record();
  if (m && before && !(await mergeOnOrigin(ctx, f, project, iid))) {
    Object.assign(m, before);
    await conflictsOnOrigin(ctx, f, project, iid);
    throw refused();
  }
  return out;
}

/** An MR set to auto-merge merges once its pipeline has passed and nothing else holds it (an
 * approval it waited for came); GitLab cancels the auto-merge when it has conflicts by then. */
export async function autoMergeIfReady(ctx: DemoContext, f: DemoForge, project: string, iid: number): Promise<void> {
  const m = mrOf(f, project, iid);
  if (!f.gitEffects || !m || m.autoMergeBy === null || m.state !== 'opened' || m.pipeline !== 'success') return;
  await conflictsOnOrigin(ctx, f, project, iid);
  if (m.hasConflicts || isDraft(m.title)) {
    m.autoMergeBy = null;
    return;
  }
  if (m.mergeStatus !== '' && m.mergeStatus !== 'mergeable') return;
  const before = recorded(m);
  m.state = m.locksOnMerge ? 'locked' : 'merged';
  m.updatedAt = f.fake.now();
  if (await mergeOnOrigin(ctx, f, project, iid)) return;
  Object.assign(m, before);
  m.autoMergeBy = null;
  await conflictsOnOrigin(ctx, f, project, iid);
}

/** `source` replayed onto `target` as git's rebase does it (checked on the binary): merges left
 * out, a pick whose parent is the new tip kept as it is, one that becomes empty dropped; null when
 * a pick conflicts. */
async function replayOnto(ctx: DemoContext, f: DemoForge, o: Origin, source: string, target: string): Promise<string | null> {
  const hidden = await historyOf(o, target);
  if (hidden.has(source)) return source;
  const picks = (await rangeCommits(o.read, source, target, hidden)).filter((c) => c.parents.length < 2).reverse();
  const committer = who(f, f.fake.me);
  let head = target;
  for (const c of picks) {
    if (c.parents[0] === head) {
      head = c.oid;
      continue;
    }
    const onto = await treeOf(o.read, head);
    const r = await replay(o.read, c.oid, onto, 'pick');
    if (r.tree === null) return null;
    const commit = await readCommit(o.read, c.oid);
    const wasEmpty = commit.tree === (c.parents.length > 0 ? await treeOf(o.read, c.parents[0]) : EMPTY_TREE);
    if (r.tree === onto && !wasEmpty) continue;
    head = await writeCommitObject(o.read, { tree: r.tree, parents: [head], message: commit.rawMessage, author: await rawAuthor(o.read, c.oid), committer }, ctx);
  }
  return head;
}

/** GitLab's Rebase made on the origin around `start` (the forge's PUT, which may refuse): the
 * source branch replayed onto its target; the MR's head moves, or on conflicts the forge's
 * `merge_error` says so. */
export async function rebaseOnOrigin(ctx: DemoContext, f: DemoForge, project: string, iid: number, start: () => void): Promise<void> {
  const m = mrOf(f, project, iid);
  const o = m?.state === 'opened' && ownSource(m) ? await originOf(ctx, f, project) : null;
  const source = o?.refs.get(`refs/heads/${m!.sourceBranch}`);
  const target = o?.refs.get(`refs/heads/${m!.targetBranch}`);
  if (!m || !o || !source || !target) return start();
  const head = await replayOnto(ctx, f, o, source, target);
  if (head === null) {
    // The forge's own failed rebase, for this one.
    const had = m.rebaseError;
    m.rebaseError ??= REBASE_FAILED;
    try {
      start();
    } finally {
      m.rebaseError = had;
    }
    return;
  }
  start();
  if (m.mergeError !== null || !(await moveRef(o, `refs/heads/${m.sourceBranch}`, source, head))) return;
  m.headSha = head;
  m.baseSha = target;
  o.refs.set(`refs/heads/${m.sourceBranch}`, head);
  stale.delete(m);
  await refreshDiffs(o, m);
  await checkConflicts(o, m);
  if (m.pipeline !== null) runPipeline(ctx, f, m);
  await branchMoved(ctx, f, project, m.sourceBranch, head);
}

/** The MRs whose pipeline's end is scheduled, by the head it runs on. */
const running = new WeakMap<FakeMergeRequest, string>();

/** Runs the MR head's pipeline (once per head): it passes after `PIPELINE_MS`. */
function runPipeline(ctx: DemoContext, f: DemoForge, m: FakeMergeRequest): void {
  const sha = m.headSha;
  if (running.get(m) === sha) return;
  running.set(m, sha);
  netOf(ctx).schedule(PIPELINE_MS, () => void pipelinePassed(ctx, f, m, sha).catch(() => undefined));
}

/** The pipeline on `sha` passed (a pipeline's status says so; `mergeStatus` moves on from waiting
 * for it): an MR set to auto-merge merges if it's ready. */
async function pipelinePassed(ctx: DemoContext, f: DemoForge, m: FakeMergeRequest, sha: string): Promise<void> {
  if (running.get(m) === sha) running.delete(m);
  if (m.headSha !== sha || !isUnfinished(m.pipeline)) return;
  m.pipeline = 'success';
  m.updatedAt = f.fake.now();
  if (m.mergeStatus === 'ci_still_running' || m.mergeStatus === 'ci_must_pass') m.mergeStatus = 'mergeable';
  await autoMergeIfReady(ctx, f, m.project, m.iid);
}

/** After an auto-merge was set: the pipeline it waits for runs to its end. */
export async function awaitPipeline(ctx: DemoContext, f: DemoForge, project: string, iid: number): Promise<void> {
  const m = mrOf(f, project, iid);
  if (m && m.state === 'opened' && m.autoMergeBy !== null && isUnfinished(m.pipeline) && (await originOf(ctx, f, project))) runPipeline(ctx, f, m);
}

/** A branch's tip on `project`'s origin (what an MR from it opens at), when the forge acts on the origin and the branch is pushed there. */
export async function originTip(ctx: DemoContext, f: DemoForge, project: string, branch: string): Promise<string | null> {
  const o = await originOf(ctx, f, project);
  return o?.refs.get(`refs/heads/${branch}`) ?? null;
}

/** A new MR gets what a push gives an existing one: its base (where its branch left the target's tip),
 * its diffs and its conflicts, from the origin. A fork's source branch isn't on the target's origin. */
export async function describeNew(ctx: DemoContext, f: DemoForge, project: string, iid: number): Promise<void> {
  const m = mrOf(f, project, iid);
  if (m) stale.delete(m);
  const o = m && ownSource(m) ? await originOf(ctx, f, project) : null;
  const target = o?.refs.get(`refs/heads/${m!.targetBranch}`);
  if (!m || !o || !target || !(await hasObject(o.fs, o.gitdir, m.headSha))) return;
  m.baseSha = (await mergeBaseOf(o.read, target, m.headSha)) ?? m.baseSha;
  await refreshDiffs(o, m);
  await checkConflicts(o, m);
}

/** MR `iid` brought up to date if its target moved since it was worked out (`stale`): what reads
 * its detail, diffs or review, or writes to it, calls first. */
export async function freshen(ctx: DemoContext, f: DemoForge, project: string, iid: number): Promise<void> {
  const m = mrOf(f, project, iid);
  if (m?.state === 'opened' && stale.has(m)) await describeNew(ctx, f, project, iid);
}

/** The open MR is worked out again when it's next looked at (`freshen`): its target changed. */
export function markStale(f: DemoForge, project: string, iid: number): void {
  const m = mrOf(f, project, iid);
  if (f.gitEffects && m?.state === 'opened') stale.add(m);
}

/** A branch moved on `project`'s origin (a push, a merge into it, GitLab's rebase of it): what a
 * push gives the open MRs from it (their head, base, diffs, conflicts and a new pipeline); the open
 * MRs into it are worked out again against the new base when they're next looked at (`stale`).
 * `tip`: the branch's new head (default: the origin's). */
export async function branchMoved(ctx: DemoContext, f: DemoForge, project: string, branch: string, tip: string | null = null): Promise<void> {
  if (!f.gitEffects) return;
  const sha = tip ?? (await originOf(ctx, f, project))?.refs.get(`refs/heads/${branch}`) ?? null;
  if (sha === null) return;
  for (const m of f.fake.seed.mergeRequests) {
    if ((m.sourceProject || m.project) !== project || m.state !== 'opened' || m.sourceBranch !== branch || m.headSha === sha) continue;
    m.headSha = sha;
    m.updatedAt = f.fake.now();
    m.pipeline = 'running';
    if (m.project === project) await describeNew(ctx, f, project, m.iid);
    runPipeline(ctx, f, m);
  }
  for (const m of f.fake.seed.mergeRequests) {
    if (m.project === project && m.state === 'opened' && m.targetBranch === branch && m.sourceBranch !== branch) stale.add(m);
  }
}

/** Ruby's `CGI.escape` of a branch (GitLab's link): everything but `A-Za-z0-9_.-~` as UTF-8 `%XX`. */
const cgiEscape = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

/** GitLab's `remote:` lines after a push of `branch` to `project` (its post-receive's merge-request
 * links): none for the default branch; else the open MR from it, or the link to create one. */
function gitlabLines(f: DemoForge, project: string, branch: string): string[] {
  const p = f.fake.seed.projects.find((x) => x.path === project);
  if (!p || branch === p.defaultBranch) return [];
  const open = f.fake.seed.mergeRequests.find((m) => (m.sourceProject || m.project) === project && m.state === 'opened' && m.sourceBranch === branch);
  if (open) return ['', `View merge request for ${branch}:`, `  ${WEB}/${open.project}/-/merge_requests/${open.iid}`, ''];
  return ['', `To create a merge request for ${branch}, visit:`, `  ${WEB}/${project}/-/merge_requests/new?merge_request%5Bsource_branch%5D=${cgiEscape(branch)}`, ''];
}

/** Network hooks: the origin serves each MR's head as `refs/merge-requests/<iid>/head`; a push to a
 * branch with an open MR moves its head and restarts its pipeline; GitLab's `remote:` lines. Each
 * reads the forge.json of bundles loaded since (a push can come before any forge read). */
export function installForgeHooks(ctx: DemoContext, f: DemoForge): void {
  const net = netOf(ctx);
  // The MR view's Compare: each MR's head as its project's origin's `refs/merge-requests/<iid>/head`.
  net.virtualRefs.push(async (fs, gitdir) => {
    await f.load(fs);
    const out = new Map<string, string>();
    const project = projectAt(f, gitdir);
    for (const m of f.fake.seed.mergeRequests) {
      if (m.project === project && m.headSha && (await hasObject(fs, gitdir, m.headSha))) out.set(`refs/merge-requests/${m.iid}/head`, m.headSha);
    }
    return out;
  });
  net.afterPush.push(async (fs, gitdir, moved) => {
    await f.load(fs);
    const project = projectAt(f, gitdir);
    if (project === null || !f.gitEffects) return;
    for (const u of moved) {
      if (u.new === null || !u.ref.startsWith('refs/heads/')) continue;
      await branchMoved(ctx, f, project, u.ref.slice('refs/heads/'.length), u.new);
    }
  });
  net.serverLines.push(async (fs, gitdir, branch) => {
    await f.load(fs);
    const project = projectAt(f, gitdir);
    return project === null || !f.gitEffects ? [] : gitlabLines(f, project, branch);
  });
}
