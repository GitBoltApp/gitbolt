// Fetch and push between the demo's git dirs (plan 4), written from git's documented behaviour
// (refspecs, `--prune`, tag following, `--force-with-lease`) and checked against the binary.
import * as git from 'isomorphic-git';
import type { DemoContext } from '../../context';
import { gbError } from '../errors';
import { fail, viewOf } from '../read/seam';
import { readRefFiles } from '../refs';
import type { DemoRepo } from '../repo';
import { isAncestor } from '../read/revs';
import { nowSeconds, shortRef, updateRef, type OpHandle } from '../writeSeam';
import { copyReachable, hasObject, peelIn, remoteRefs } from './objects';
import { netOf, resolveRemote } from './network';

export interface RefUpdate { ref: string; old: string | null; new: string | null }
export interface Refspec { force: boolean; src: string; dst: string }
export const COMPARE_REFS = 'refs/gitvolt/compare/';
/** What git's reflog says of a fetched ref, after its command line (git 2.53, Task 13 Step 1). */
const STORING = 'storing head';
const FAST_FORWARD = 'fast-forward';
const FORCED = 'forced-update';

export function parseRefspec(spec: string): Refspec {
  const force = spec.startsWith('+');
  const [src, dst = ''] = (force ? spec.slice(1) : spec).split(':');
  return { force, src, dst };
}

export function mapRef(spec: Refspec, name: string): string | null {
  const star = spec.src.indexOf('*');
  if (star < 0) return name === spec.src ? spec.dst : null;
  const [pre, post] = [spec.src.slice(0, star), spec.src.slice(star + 1)];
  if (!name.startsWith(pre) || !name.endsWith(post) || name.length < pre.length + post.length) return null;
  return spec.dst.replace('*', name.slice(pre.length, name.length - post.length));
}

export const cancelled = () => gbError('Cancelled', 'Cancelled');

/** The refs a failed `fetchInto` moved before it failed (git goes on past a rejected ref). */
const movedBy = new WeakMap<object, RefUpdate[]>();
/** What `fetchInto` moved before throwing `e` (empty when it moved nothing): the caller still says
 *  `refsUpdated` for them, as the core's ref comparison does. */
export function movedBefore(e: unknown): RefUpdate[] {
  return (typeof e === 'object' && e !== null && movedBy.get(e)) || [];
}

export function transferTime(ctx: DemoContext, op: OpHandle): Promise<void> {
  const ms = netOf(ctx).latencyMs;
  return new Promise((resolve, reject) => {
    if (op.cancelled()) return reject(cancelled());
    if (ms <= 0) return resolve();
    const timer = setTimeout(resolve, ms);
    op.onCancel(() => {
      clearTimeout(timer);
      reject(cancelled());
    });
  });
}

/** `git fetch <remote>` into `demo`: the configured refspecs (git's default without one), or
 *  `extra` alone (a refspec on the command line, as an MR head's: no tracking ref moves and none is
 *  pruned), tags into what is here followed. With `op`, it waits the transfer time once the remote
 *  answers, and a Cancel before the refs are written leaves them all as they were. `reflog`: the
 *  command line git's reflog names (`fetch …`, without `git`). A ref rejected as a non-fast-forward
 *  throws `NonFastForward` once the others are written; `movedBefore(e)` lists those. */
export async function fetchInto(ctx: DemoContext, demo: DemoRepo, remote: string, o: { prune: boolean; extra?: { src: string; dst: string }; op?: OpHandle; reflog?: string }): Promise<{ changed: boolean; updates: RefUpdate[] }> {
  const url = (await demo.config(`remote.${remote}.url`)) ?? fail('NotFound', `No remote ${remote}`);
  const fs = demo.fs;
  const gitdir = await resolveRemote(ctx, fs, url, 'fetching from');
  for (const hook of netOf(ctx).beforeNetwork) await hook(fs, gitdir);
  if (o.op) await transferTime(ctx, o.op);
  const theirs = await remoteRefs(ctx, fs, gitdir);
  let specs: Refspec[];
  if (o.extra) {
    if (!theirs.has(o.extra.src)) fail('Other', `couldn't find remote ref ${o.extra.src}`);
    specs = [{ force: true, ...o.extra }];
  } else {
    const configured = await demo.configAll(`remote.${remote}.fetch`);
    specs = (configured.length ? configured : [`+refs/heads/*:refs/remotes/${remote}/*`]).map(parseRefspec);
  }
  const wanted = new Map<string, { oid: string; force: boolean; src: string }>();
  for (const [name, oid] of theirs) {
    for (const s of specs) {
      const dst = mapRef(s, name);
      if (dst) wanted.set(dst, { oid, force: s.force, src: name });
    }
  }
  await copyReachable(fs, gitdir, demo.gitdir, [...new Set([...wanted.values()].map((w) => w.oid))]);
  // git's default tag following (checked on the binary): a tag this repository lacks whose commit
  // is now here (fetched, or here before), an annotated tag's object copied with it; a tag on
  // anything else isn't, and an existing tag is never moved.
  const refs = demo.refMap();
  const followed: string[] = [];
  for (const [name, oid] of theirs) {
    if (!name.startsWith('refs/tags/') || refs.has(name) || wanted.has(name)) continue;
    if (await hasObject(fs, demo.gitdir, await peelIn(fs, gitdir, oid))) {
      wanted.set(name, { oid, force: false, src: name });
      followed.push(oid);
    }
  }
  await copyReachable(fs, gitdir, demo.gitdir, followed);
  const read = viewOf(demo);
  const moves: { ref: string; old: string | null; new: string; why: string }[] = [];
  const rejected: { dst: string; src: string }[] = [];
  for (const [dst, { oid, force, src }] of wanted) {
    const old = demo.resolveRef(refs, dst);
    if (old === oid || (old !== null && dst.startsWith('refs/tags/'))) continue;
    const ff = old === null || (await isAncestor(read, old, oid));
    if (!ff && !force) rejected.push({ dst, src });
    else moves.push({ ref: dst, old, new: oid, why: old === null ? STORING : ff ? FAST_FORWARD : FORCED });
  }
  // `--prune` with the configured refspecs: a tracking ref whose branch the remote no longer has
  // (git prunes first, so a `a` → `a/b` rename lands).
  const pruned: RefUpdate[] = [];
  if (o.prune && !o.extra) {
    for (const s of specs) {
      const star = s.dst.indexOf('*');
      const prefix = star < 0 ? s.dst : s.dst.slice(0, star);
      for (const [name, f] of refs) {
        if (!name.startsWith('refs/remotes/') || !(star < 0 ? name === prefix : name.startsWith(prefix)) || f.symref || wanted.has(name)) continue;
        if (!pruned.some((p) => p.ref === name)) pruned.push({ ref: name, old: demo.resolveRef(refs, name), new: null });
      }
    }
  }
  // The point of no return: a Cancel until now writes nothing.
  if (o.op?.cancelled()) throw cancelled();
  const now = nowSeconds(ctx);
  const argv = o.reflog ?? `fetch ${remote}`;
  // A delete writes no reflog (git drops the ref's log with it).
  for (const p of pruned) await updateRef(read, demo.gitdir, p.ref, p.old, null, '', now);
  for (const m of moves) await updateRef(read, demo.gitdir, m.ref, m.old, m.new, `${argv}: ${m.why}`, now);
  const updates: RefUpdate[] = [...pruned, ...moves.map(({ ref, old, new: next }) => ({ ref, old, new: next }))];
  const tips = await Promise.all(moves.map((m) => peelIn(fs, demo.gitdir, m.new)));
  if (tips.length) await demo.addCommits(tips);
  if (rejected.length) {
    const e = gbError('NonFastForward', `${rejected[0].dst}: the remote's ${shortRef(rejected[0].src)} isn't a fast-forward (rejected)`);
    movedBy.set(e, updates);
    throw e;
  }
  return { changed: updates.length > 0, updates };
}

/** What a pushed ref's rejection says, as git's line after `To <url>` (the caller words it as the core). */
function refusal(kind: 'NonFastForward' | 'RefMoved', src: string | null, dst: string, why: string) {
  const short = dst.replace(/^refs\/(heads|tags)\//, '');
  return gbError(kind, `! [rejected]        ${src === null ? '(delete)' : short} -> ${short} (${why})`);
}

/** One ref of `git push` from `demo` into the git dir `gitdir` (`src` null: a delete), checked as
 *  git checks it on the binary: the same value is up to date (a lease isn't looked at then; a
 *  delete is always sent, and one of a ref the remote lacks changes nothing, `old` null); with
 *  a lease (`--force-with-lease=<dst>:<oid>`, null: it must not exist) the remote's value must be
 *  it, and then anything goes (`stale info`); without one, a tag the remote has is never moved
 *  (`already exists`); otherwise the remote's value must be in `src`'s history (`fetch first` when
 *  this repository lacks it). The commits go first, then the ref; the `afterPush` hooks see it. */
export async function pushRef(ctx: DemoContext, demo: DemoRepo, gitdir: string, o: { src: string | null; dst: string; lease?: string | null }): Promise<{ old: string | null; upToDate: boolean }> {
  const fs = demo.fs;
  const old = readRefFiles(fs, gitdir).find((f) => f.full === o.dst)?.oid ?? null;
  if (o.src !== null && o.src === old) return { old, upToDate: true };
  if (o.lease !== undefined) {
    if (old !== o.lease) throw refusal('RefMoved', o.src, o.dst, 'stale info');
  } else if (old !== null && o.src !== null) {
    if (o.dst.startsWith('refs/tags/')) throw refusal('NonFastForward', o.src, o.dst, 'already exists');
    if (!(await hasObject(fs, demo.gitdir, old))) throw refusal('NonFastForward', o.src, o.dst, 'fetch first');
    if (!(await isAncestor(viewOf(demo), old, o.src))) throw refusal('NonFastForward', o.src, o.dst, 'non-fast-forward');
  }
  if (o.src !== null) {
    await copyReachable(fs, demo.gitdir, gitdir, [o.src]);
    await git.writeRef({ fs, gitdir, ref: o.dst, value: o.src, force: true });
  } else if (old !== null) await git.deleteRef({ fs, gitdir, ref: o.dst });
  else return { old, upToDate: false };
  for (const hook of netOf(ctx).afterPush) await hook(fs, gitdir, [{ ref: o.dst, old, new: o.src }]);
  return { old, upToDate: false };
}
