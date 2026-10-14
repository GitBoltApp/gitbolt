// The sidebar's branches, remotes, worktrees, stashes and tags (spec §6.4), as
// shelldata::sidebar reads them.
import type { LocalBranch } from '../../api/gen/LocalBranch';
import type { SidebarPayload } from '../../api/gen/SidebarPayload';
import type { TagItem } from '../../api/gen/TagItem';
import { annotationOf, subject } from './objects';
import { basename } from './paths';
import { viewOf } from './read/seam';
import { rewrittenOf } from './seq/rewrites';
import type { RefFile } from './refs';
import { hostKind, mismatchedUpstream, parseRemoteUrl, remoteFor, trackingRef } from './remotes';
import type { DemoRepo } from './repo';

const nonEmpty = (v: string | null) => (v === null || v === '' ? null : v);

/** Where Push sends `branch` (§12.3): the push remote and the same name, else the upstream. */
export async function pushTarget(repo: DemoRepo, branch: string): Promise<{ remote: string; branch: string } | null> {
  const push = nonEmpty(await repo.config(`branch.${branch}.pushRemote`)) ?? nonEmpty(await repo.config('remote.pushDefault'));
  if (push !== null) return { remote: push, branch };
  const remote = nonEmpty(await repo.config(`branch.${branch}.remote`));
  if (remote === null || remote === '.') return null;
  const merge = nonEmpty(await repo.config(`branch.${branch}.merge`));
  if (merge === null) return null;
  return { remote, branch: merge.startsWith('refs/heads/') ? merge.slice(11) : merge };
}

/** `branch`'s upstream ref, remote and merge (git's `branch_get_upstream`, shelldata::upstream_ref). */
async function upstreamRef(repo: DemoRepo, branch: string): Promise<{ full: string; remote: string; merge: string } | null> {
  const remote = await repo.config(`branch.${branch}.remote`);
  const merge = (await repo.configAll(`branch.${branch}.merge`))[0];
  if (remote === null || merge === undefined) return null;
  const tracked = trackingRef(await repo.configAll(`remote.${remote}.fetch`), merge);
  const full = tracked ?? (remote === '.' ? (merge.startsWith('refs/') ? merge : `refs/heads/${merge}`) : null);
  return full === null ? null : { full, remote, merge };
}

/** The commit the ref `name` peels to, or null. */
async function peeled(repo: DemoRepo, refs: Map<string, RefFile>, name: string): Promise<string | null> {
  const oid = repo.resolveRef(refs, name);
  return oid === null ? null : repo.peelToCommit(oid);
}

export async function buildSidebar(repo: DemoRepo): Promise<SidebarPayload> {
  const files = repo.refFiles();
  const refs = repo.refMap(files);
  const worktrees = await repo.worktrees(refs);
  const remotes = await repo.remotes();
  const remoteNames = remotes.map((r) => r.name);
  const urlOf = new Map(remotes.map((r) => [r.name, r.url]));
  const hostOf = (remote: string) => {
    const url = urlOf.get(remote);
    return url ? (parseRemoteUrl(url)?.host ?? null) : null;
  };
  const headBranch = repo.head(refs).branch;
  const here = repo.path;
  const elsewhere = new Map<string, string>();
  const checkedOut = new Map<string, string>();
  for (const w of worktrees) {
    if (w.branch === null) continue;
    if (w.canonical !== here) elsewhere.set(w.branch, w.path);
    checkedOut.set(w.branch, w.path);
  }
  const s: SidebarPayload = { locals: [], remotes: [], worktrees: [], stashes: [], tags: [] };
  const defaults = new Map<string, string>();
  for (const f of files) {
    if (f.symref !== null) {
      // `refs/remotes/<r>/HEAD` names that remote's default branch.
      const m = /^refs\/remotes\/(.+)\/HEAD$/.exec(f.full);
      if (m) defaults.set(m[1], f.symref);
      continue;
    }
    const listed = f.full.startsWith('refs/heads/') || f.full.startsWith('refs/remotes/') || f.full.startsWith('refs/tags/');
    if (!listed || f.oid === null) continue;
    const target = await repo.refTarget(f.oid);
    const commit = target === null ? undefined : repo.commits.get(target.commit);
    if (target === null || commit === undefined) continue;
    const tagSubject = target.tag ? subject(target.tag.message) : '';
    const row = { target: target.commit, tipTime: commit.committerTime, summary: tagSubject || subject(commit.message), author: commit.authorName };
    if (f.full.startsWith('refs/heads/')) {
      const name = f.full.slice('refs/heads/'.length);
      const ref = await upstreamRef(repo, name);
      let up = { full: '', ahead: 0, behind: 0, gone: false, remote: '', merge: '' };
      if (ref) {
        const tip = await peeled(repo, refs, ref.full);
        const [ahead, behind] = tip === null || tip === row.target ? [0, 0] : repo.aheadBehind(row.target, tip);
        up = { ...ref, ahead, behind, gone: tip === null };
      }
      const local: LocalBranch = {
        name, fullName: f.full, target: row.target, upstream: up.full === '' ? null : up.full, ahead: up.ahead, behind: up.behind, gone: up.gone,
        tipTime: row.tipTime, summary: row.summary, author: row.author, isHead: headBranch === f.full,
        worktree: elsewhere.get(f.full) ?? null, checkedOut: checkedOut.get(f.full) ?? null, pushTarget: null, pushBehind: null, rewritten: null,
      };
      const mismatch = mismatchedUpstream(name, up.remote, up.merge);
      if (mismatch !== null) local.upstreamMismatch = mismatch;
      s.locals.push(local);
    } else if (f.full.startsWith('refs/remotes/')) {
      const rest = f.full.slice('refs/remotes/'.length);
      const remote = remoteFor(rest, remoteNames);
      if (remote === null) continue;
      const branch = { name: rest.slice(remote.length + 1), fullName: f.full, target: row.target, tipTime: row.tipTime, summary: row.summary, author: row.author };
      const group = s.remotes.find((g) => g.name === remote);
      if (group) group.branches.push(branch);
      else {
        const host = hostOf(remote);
        s.remotes.push({ name: remote, host, hostKind: host === null ? 'generic' : hostKind(host), branches: [branch] });
      }
    } else {
      const tag: TagItem = { name: f.full.slice('refs/tags/'.length), fullName: f.full, target: row.target, time: row.tipTime };
      if (target.tag) tag.annotation = annotationOf(target.tag);
      s.tags.push(tag);
    }
  }
  for (const g of s.remotes) {
    const d = defaults.get(g.name);
    if (d !== undefined) g.defaultBranch = d;
  }
  const view = viewOf(repo);
  for (const b of s.locals) {
    b.rewritten = await rewrittenOf(view, b.name);
    const t = await pushTarget(repo, b.name);
    if (!t) continue;
    const label = `${t.remote}/${t.branch}`;
    const exists = s.remotes.some((g) => g.name === t.remote && g.branches.some((r) => r.name === t.branch));
    const theirs = `refs/remotes/${label}`;
    if (!exists) b.pushBehind = null;
    else if (b.upstream === theirs) b.pushBehind = b.behind;
    else {
      // A triangular setup: commits on the push target the branch lacks.
      const tip = await peeled(repo, refs, theirs);
      b.pushBehind = tip === null ? null : repo.aheadBehind(tip, b.target)[0];
    }
    b.pushTarget = label;
  }
  s.worktrees = worktrees.filter((w) => !w.bare).map((w) => ({
    path: w.path,
    name: basename(w.path),
    branch: w.branch === null ? null : w.branch.replace(/^(refs\/heads\/)+/, ''),
    head: w.head,
    isMain: w.isMain,
    isCurrent: w.canonical === here,
    locked: w.locked,
  }));
  s.stashes = repo.stashes().map((x) => ({ index: x.index, id: x.id, message: x.message, time: x.time }));
  return s;
}
