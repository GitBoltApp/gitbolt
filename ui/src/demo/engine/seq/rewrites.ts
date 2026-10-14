// Rewrite marks (the core's write/rewrites.rs): a rebase or amend of a branch whose push target's
// tracking ref it rewrote away from records that oid; a later Push that would be refused forces
// with it as the lease, without asking. In memory, per repository (the demo has no data dir).
import type { RewriteKind } from '../../../api/gen/RewriteKind';
import { readCommit } from '../read/commitText';
import { ancestors } from '../read/revs';
import { demoOf, type ReadRepo } from '../read/seam';
import type { DemoRepo } from '../repo';
import { pushTarget } from '../sidebar';
import { readRef, type RefMove } from '../writeSeam';
import { isAncestor } from './range';

export interface RewriteMark { branch: string; remote: string; remoteBranch: string; remoteRef: string; leaseOid: string; newTip: string; kind: RewriteKind }

const store = new WeakMap<DemoRepo, RewriteMark[]>();
function marksOf(read: ReadRepo): RewriteMark[] {
  const d = demoOf(read);
  let m = store.get(d);
  if (!m) store.set(d, (m = []));
  return m;
}
const refValue = (read: ReadRepo, name: string): string | null => readRef(demoOf(read), name);

/** The mark still applies to a branch at `tip`: it's the rewrite's tip or a descendant. */
async function liveAt(read: ReadRepo, m: RewriteMark, tip: string | null): Promise<boolean> {
  return tip !== null && (await isAncestor(read, m.newTip, tip));
}
/** Its push target is still the one it was recorded for. */
async function sameTarget(read: ReadRepo, m: RewriteMark): Promise<boolean> {
  const t = await pushTarget(demoOf(read), m.branch);
  return t !== null && t.remote === m.remote && t.branch === m.remoteBranch;
}
/** `branch` is `remote`'s default branch: what `refs/remotes/<remote>/HEAD` names, or (with no such
 *  ref) main, master or trunk. A force there is never silent. */
function isDefaultBranch(read: ReadRepo, remote: string, branch: string): boolean {
  const head = demoOf(read).refMap().get(`refs/remotes/${remote}/HEAD`)?.symref ?? null;
  return head !== null ? head === `refs/remotes/${remote}/${branch}` : ['main', 'master', 'trunk'].includes(branch);
}
/** Every commit the rewrite replaces (`new..lease` on the remote, `new..old` locally) is the user's
 *  own, by author email: someone else's work is never forced away without asking. */
async function allMine(read: ReadRepo, me: string, lease: string, old: string, next: string): Promise<boolean> {
  const hidden = await ancestors(read, next);
  const seen = new Set<string>();
  const queue = [lease, old];
  while (queue.length > 0) {
    const at = queue.pop()!;
    if (hidden.has(at) || seen.has(at)) continue;
    seen.add(at);
    const c = await readCommit(read, at);
    if (c.author.email.toLowerCase() !== me.toLowerCase()) return false;
    queue.push(...c.parents);
  }
  return true;
}

/** The core's `rewrites::after_write`: after a write moved `moves` (`kind`: it rewrites, and
 *  succeeded; `me`: the author email commits are made with), records a mark for each branch it
 *  rewrote whose push target's tracking ref it left behind, and drops each moved branch's mark that
 *  no longer applies. A branch rewritten again while its mark is live keeps the first lease. */
export async function recordRewrite(read: ReadRepo, kind: RewriteKind | null, moves: RefMove[], me = ''): Promise<void> {
  const marks = marksOf(read);
  for (const m of moves) {
    if (!m.name.startsWith('refs/heads/')) continue;
    const branch = m.name.slice('refs/heads/'.length);
    const at = marks.findIndex((x) => x.branch === branch);
    const { old, new: next } = m;
    if (kind === null || old === null || next === null || old === next || (await isAncestor(read, old, next))) {
      if (at >= 0 && !(await liveAt(read, marks[at], next))) marks.splice(at, 1);
      continue;
    }
    const kept = at >= 0 && (await liveAt(read, marks[at], old)) && (await sameTarget(read, marks[at])) ? marks[at].leaseOid : null;
    if (at >= 0) marks.splice(at, 1);
    const t = await pushTarget(demoOf(read), branch);
    if (!t) continue;
    const remoteRef = `refs/remotes/${t.remote}/${t.branch}`;
    let lease = kept;
    if (lease === null) {
      const tracking = refValue(read, remoteRef);
      lease = tracking !== null && (await isAncestor(read, tracking, old)) ? tracking : null;
    }
    // An identity with no email matches nothing: an empty author email isn't the user's.
    if (lease === null || me.trim() === '') continue;
    if (!(await isAncestor(read, lease, next)) && !isDefaultBranch(read, t.remote, t.branch) && (await allMine(read, me, lease, old, next))) {
      marks.push({ branch, remote: t.remote, remoteBranch: t.branch, remoteRef, leaseOid: lease, newTip: next, kind });
    }
  }
}

/** The core's `lease_for`: the mark's lease and the tip it checked, when a plain push of `branch` to
 *  `target` would be refused. A dead mark is dropped here. */
export async function leaseFor(read: ReadRepo, branch: string, target: { remote: string; branch: string }): Promise<{ mark: RewriteMark; tip: string } | null> {
  const marks = marksOf(read);
  const i = marks.findIndex((m) => m.branch === branch);
  if (i < 0) return null;
  const tip = refValue(read, `refs/heads/${branch}`);
  if (!(await liveAt(read, marks[i], tip)) || !(await sameTarget(read, marks[i]))) {
    marks.splice(i, 1);
    return null;
  }
  const mark = marks[i];
  if (mark.remote !== target.remote || mark.remoteBranch !== target.branch) return null;
  const theirs = refValue(read, mark.remoteRef);
  return theirs !== null && tip !== null && !(await isAncestor(read, theirs, tip)) ? { mark, tip } : null;
}

/** A push of `branch` went in: its mark is spent. */
export function pushed(read: ReadRepo, branch: string): void {
  const marks = marksOf(read);
  const i = marks.findIndex((m) => m.branch === branch);
  if (i >= 0) marks.splice(i, 1);
}

/** The sidebar's `rewritten`: a branch's live mark for its current push target, while the tracking
 *  ref is still the lease. A mark seen dead is dropped. */
export async function rewrittenOf(read: ReadRepo, branch: string): Promise<{ kind: RewriteKind; remote: string } | null> {
  const marks = marksOf(read);
  const m = marks.find((x) => x.branch === branch);
  if (!m) return null;
  if (!(await liveAt(read, m, refValue(read, `refs/heads/${branch}`))) || !(await sameTarget(read, m))) {
    marks.splice(marks.indexOf(m), 1);
    return null;
  }
  return refValue(read, m.remoteRef) === m.leaseOid ? { kind: m.kind, remote: m.remote } : null;
}
