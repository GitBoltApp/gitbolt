// Push and tag pushes (the core's write/sync.rs PushIntent and write/tags.rs PushTags), and the
// remote legs of deleting a branch or a tag (write/branch_delete.rs, write/tags.rs DeleteTag), over
// the demo's network: commits copied to the origin, its ref moved as git's checks allow (never a
// force without a lease), the tracking ref and upstream set, the server's lines shown. The
// transfer runs with the write lock released (`cx.network`), as the core's does.
import type { Confirm } from '../../../api/gen/Confirm';
import type { Lease } from '../../../api/gen/Lease';
import type { PullMode } from '../../../api/gen/PullMode';
import type { PullOutcome } from '../../../api/gen/PullOutcome';
import type { PullResult } from '../../../api/gen/PullResult';
import type { PushOutcome } from '../../../api/gen/PushOutcome';
import type { PushTarget } from '../../../api/gen/PushTarget';
import type { RemoteSummary } from '../../../api/gen/RemoteSummary';
import type { TagPushOutcome } from '../../../api/gen/TagPushOutcome';
import type { DemoContext } from '../../context';
import { asGbError } from '../errors';
import { compareBytewise } from '../read/bytes';
import { predictConflicts } from '../read/merge3';
import { ancestors, relation } from '../read/revs';
import { fail, viewOf } from '../read/seam';
import { readRefFiles } from '../refs';
import { redact } from '../remotes';
import type { DemoRepo } from '../repo';
import { rebaseIntent } from '../seq/rebase';
import { branchesElsewhere } from '../seq/range';
import { leaseFor, pushed } from '../seq/rewrites';
import { pushTarget } from '../sidebar';
import { remoteUrlError } from '../../../forge/remoteUrl';
import { deleteRefFiles, isRemoteKey, nowSeconds, readLocalConfig, recordRemovedRemote, readRef, remoteNameError, removeConfigSection, runMerge, setConfigValues, updateRef, watchRefs, type OpHandle, type WriteIntent } from '../writeSeam';
import { netOf, resolveRemote } from './network';
import { classify, summarize } from './serverLines';
import { cancelled, fetchInto, mapRef, movedBefore, parseRefspec, pushRef, transferTime } from './transfer';

const tagRef = (name: string) => `refs/tags/${name}`;

/** `remote`'s URL, refused in git's words when there's no such remote. */
async function urlOf(demo: DemoRepo, remote: string): Promise<string> {
  return (await demo.config(`remote.${remote}.url`)) ?? fail('NotFound', `'${remote}' does not appear to be a git repository`);
}

/** The git dir `url` reaches ("Not in the demo" for anything else), once the network's
 *  `beforeNetwork` hooks (the teammate) have run, and the transfer time waited (a Cancel there
 *  writes nothing). */
async function connect(ctx: DemoContext, demo: DemoRepo, url: string, op: OpHandle): Promise<string> {
  const gitdir = await resolveRemote(ctx, demo.fs, url, 'pushing to');
  for (const hook of netOf(ctx).beforeNetwork) await hook(demo.fs, gitdir);
  await transferTime(ctx, op);
  return gitdir;
}

/** The tracking ref git moves for a push to `dst` on `remote`: `dst` through the remote's
 *  configured fetch refspecs (none: no tracking ref, as git). */
async function trackingOf(demo: DemoRepo, remote: string, dst: string): Promise<string | null> {
  for (const spec of (await demo.configAll(`remote.${remote}.fetch`)).map(parseRefspec)) {
    const mapped = mapRef(spec, dst);
    if (mapped) return mapped;
  }
  return null;
}

/** `--follow-tags` (checked on the binary): the annotated tags here the origin lacks whose commit
 *  is in what is pushed, sent even when the branch itself is then refused. */
async function followTags(demo: DemoRepo, gitdir: string, tip: string): Promise<{ name: string; oid: string }[]> {
  const theirs = new Set(readRefFiles(demo.fs, gitdir).map((f) => f.full));
  const refs = demo.refMap();
  const reach = await ancestors(viewOf(demo), tip);
  const out: { name: string; oid: string }[] = [];
  for (const name of refs.keys()) {
    if (!name.startsWith('refs/tags/') || theirs.has(name)) continue;
    const oid = demo.resolveRef(refs, name);
    const t = oid === null ? null : await demo.refTarget(oid);
    if (oid !== null && t?.tag && reach.has(t.commit)) out.push({ name, oid });
  }
  return out;
}

/** The core's `PushIntent`: `git push --progress [-u] [--follow-tags] [--force-with-lease=…]
 *  <remote> <src>:refs/heads/<target>`. `shown`: the target as the click resolved it (the label,
 *  and the tracking ref verify watches); without `target` the upstream is read again as it runs. */
export function pushIntent(o: { branch: string; target?: PushTarget; setUpstream: boolean; lease?: Lease; shown?: PushTarget }): WriteIntent<PushOutcome> {
  const shown = o.target ?? o.shown ?? null;
  return {
    kind: 'push',
    label: () => (shown ? `push ${o.branch} to ${shown.remote}/${shown.branch}` : `push ${o.branch}`),
    undo: 'barrier',
    refs: () => [`refs/heads/${o.branch}`, ...(shown ? [`refs/remotes/${shown.remote}/${shown.branch}`] : [])],
    async run(cx) {
      const demo = cx.repo;
      const target = o.target ?? (await pushTarget(demo, o.branch)) ?? fail('InvalidInput', `${o.branch} has no upstream; set one from Push ▾`);
      const dst = `refs/heads/${target.branch}`;
      const tracking = await trackingOf(demo, target.remote, dst);
      if (tracking !== null) watchRefs(cx, [[tracking, readRef(demo, tracking)]]);
      // §12.3: a branch GitVolt rewrote since its last push forces with the lease recorded then,
      // when a plain push would be refused. An explicit force keeps its own lease.
      const mark = o.lease !== undefined ? null : await leaseFor(cx.read, o.branch, target);
      const lease = o.lease !== undefined ? o.lease.oid : mark ? mark.mark.leaseOid : undefined;
      const url = await urlOf(demo, target.remote);
      const local = readRef(demo, `refs/heads/${o.branch}`);
      // The forced push sends the tip `leaseFor` checked, not whatever the branch is by then.
      const src = mark && !o.setUpstream ? mark.tip : (local ?? fail('Other', `src refspec refs/heads/${o.branch} does not match any`));
      let sent: { branch: { old: string | null; upToDate: boolean }; tags: number; server: RemoteSummary };
      try {
        sent = await cx.network(async () => {
          const gitdir = await connect(cx.ctx, demo, url, cx.opHandle);
          const tags = cx.ctx.state.settings.pushFollowTags ? await followTags(demo, gitdir, src) : [];
          // The point of no return: a Cancel until now writes nothing.
          if (cx.opHandle.cancelled()) throw cancelled();
          for (const t of tags) await pushRef(cx.ctx, demo, gitdir, { src: t.oid, dst: t.name });
          const branch = await pushRef(cx.ctx, demo, gitdir, { src, dst, ...(lease !== undefined ? { lease } : {}) });
          // git moves the tracking ref itself, up to date or not.
          const was = tracking === null ? src : readRef(demo, tracking);
          if (tracking !== null && was !== src) await updateRef(cx.read, demo.gitdir, tracking, was, src, 'update by push', nowSeconds(cx.ctx));
          // The server speaks when the branch moved (an up-to-date push never reaches its hooks).
          const raw: string[] = [];
          if (!branch.upToDate) for (const source of netOf(cx.ctx).serverLines) raw.push(...(await source(demo.fs, gitdir, target.branch, branch.old === null)));
          const lines = classify(raw);
          if (lines.length > 0) cx.ctx.emit({ type: 'opRemote', op: cx.op, lines });
          return { branch, tags: tags.length, server: summarize(lines) };
        });
      } catch (e) {
        const err = asGbError(e);
        const stale = err.kind === 'RefMoved' && err.message.includes('(stale info)');
        // The mark's lease failed (someone pushed since the rewrite): today's rejected push.
        if (mark && stale) err.kind = 'NonFastForward';
        if (err.kind === 'NonFastForward') err.message = `${target.remote}/${target.branch} has commits ${o.branch} doesn't have`;
        // An explicit lease's refusal is git's first line, as the core's message.
        else if (stale) err.message = `To ${redact(url)}`;
        throw err;
      } finally {
        cx.touch('refs');
        if (o.setUpstream) cx.touch('config');
      }
      if (o.setUpstream) {
        await setConfigValues(cx.read, `branch.${o.branch}.remote`, [target.remote]);
        await setConfigValues(cx.read, `branch.${o.branch}.merge`, [dst]);
      }
      pushed(cx.read, o.branch);
      return { op: cx.op, branch: o.branch, remote: target.remote, dst: target.branch, upToDate: sent.branch.upToDate && sent.tags === 0, server: sent.server, forced: mark ? mark.mark.kind : null };
    },
  };
}

/** The core's `PushTags`: one tag (`refs/tags/<t>:refs/tags/<t>`) or every tag (`--tags`). Never a
 *  force: a tag the remote has on another object is refused, the others still sent (git's). */
export function pushTagsIntent(o: { remote: string; tag: string | null }): WriteIntent<TagPushOutcome> {
  return {
    kind: 'push',
    label: () => (o.tag !== null ? `push tag ${o.tag} to ${o.remote}` : `push all tags to ${o.remote}`),
    undo: 'barrier',
    staging: 'keep',
    refs: () => (o.tag !== null ? [tagRef(o.tag)] : []),
    async plan(pre) {
      if (o.tag !== null && !pre.before.refs.get(tagRef(o.tag))) fail('NotFound', `No tag ${o.tag}`);
      return {};
    },
    async run(cx) {
      const demo = cx.repo;
      const url = await urlOf(demo, o.remote);
      const refs = demo.refMap();
      const names = o.tag !== null ? [tagRef(o.tag)] : [...refs.keys()].filter((n) => n.startsWith('refs/tags/'));
      let sent: number;
      try {
        sent = await cx.network(async () => {
          const gitdir = await connect(cx.ctx, demo, url, cx.opHandle);
          let moved = 0;
          let clash = false;
          for (const n of names) {
            const oid = demo.resolveRef(refs, n);
            if (oid === null) continue;
            try {
              if (!(await pushRef(cx.ctx, demo, gitdir, { src: oid, dst: n })).upToDate) moved++;
            } catch (e) {
              if (asGbError(e).kind !== 'NonFastForward') throw e;
              clash = true;
            }
          }
          if (clash) fail('NonFastForward', o.tag !== null ? `${o.remote} already has a different tag ${o.tag}` : `${o.remote} already has different tags with some of these names`);
          return moved;
        });
      } finally {
        cx.touch('refs');
      }
      return { op: cx.op, remote: o.remote, tag: o.tag, upToDate: sent === 0, server: { lines: 0, warning: null } };
    },
  };
}

/** The remote leg of deleting `branch` on `remote` (branch_delete.rs): `git push
 *  --force-with-lease=refs/heads/<b>:<lease> <remote> --delete refs/heads/<b>`, `lease` the
 *  tracking oid the UI showed; git drops the tracking ref with it. Run it inside `cx.network`. */
export async function deleteRemoteBranch(ctx: DemoContext, demo: DemoRepo, remote: string, branch: string, o: { lease: string; op: OpHandle }): Promise<void> {
  const dst = `refs/heads/${branch}`;
  const gitdir = await connect(ctx, demo, await urlOf(demo, remote), o.op);
  try {
    await pushRef(ctx, demo, gitdir, { src: null, dst, lease: o.lease });
  } catch (e) {
    // The lease failed: the remote moved since the tracking ref was fetched.
    if (asGbError(e).kind === 'RefMoved') fail('RefMoved', `${remote}/${branch} changed on the server. Fetch, then try again.`);
    throw e;
  }
  const tracking = await trackingOf(demo, remote, dst);
  const was = tracking === null ? null : readRef(demo, tracking);
  // A delete writes no reflog (git drops the ref's log with it).
  if (tracking !== null && was !== null) await updateRef(viewOf(demo), demo.gitdir, tracking, was, null, '', nowSeconds(ctx));
}

/** The remote leg of deleting tag `tag` on `remote` (tags.rs `DeleteTag`): `git push <remote>
 *  :refs/tags/<t>`. git sends the delete of a tag the remote lacks, and the server only warns:
 *  that's refused here, as the core does, before a local tag goes. Run it inside `cx.network`. */
export async function deleteRemoteTag(ctx: DemoContext, demo: DemoRepo, remote: string, tag: string, o: { op: OpHandle }): Promise<void> {
  const gitdir = await connect(ctx, demo, await urlOf(demo, remote), o.op);
  const { old } = await pushRef(ctx, demo, gitdir, { src: null, dst: tagRef(tag) });
  if (old === null) {
    ctx.emit({ type: 'opRemote', op: o.op.id, lines: classify(['warning: deleting a non-existent ref']) });
    fail('NotFound', `${remote} has no tag ${tag}`);
  }
}

/** The core's `PullIntent`: `branch` from its upstream (`remote`'s `merge` branch), fetched first.
 *  The fetch (`transfer_first`) holds only the queue's slot: before the lock, the preflight, any
 *  snapshot or autostash, and outside the journal entry, which watches the local branch only (the
 *  fetched tracking refs aren't journaled). `plan` then reads the relation under the lock. */
export function pullIntent(o: { branch: string; remote: string; merge: string; mode: PullMode; confirm: Confirm; checkedOut: boolean }): WriteIntent<PullOutcome> {
  const short = o.merge.replace(/^refs\/heads\//, '');
  const upstream = `${o.remote}/${short}`;
  const upstreamRef = `refs/remotes/${o.remote}/${short}`;
  const local = `refs/heads/${o.branch}`;
  const rebase = rebaseIntent({ target: upstreamRef, confirm: o.confirm });
  let planned: { checkedOut: boolean; local: string; theirs: string; ahead: number; behind: number } | null = null;
  const autostash = (rule: 'overlap' | 'merged' | 'rebased', theirs: string) => ({ rule: { kind: rule } as const, target: theirs, op: `pull ${upstream}`, targetName: upstream });
  return {
    kind: 'pull',
    label: () => `pull ${o.branch}`,
    // Rewind when the branch is checked out, else the ref moves alone. Settled in `plan`, under the
    // lock: a queued checkout ahead of this pull may have changed it since the request.
    get undo() {
      return (planned?.checkedOut ?? o.checkedOut) ? 'rewind' : 'moveRefs';
    },
    confirm: o.confirm,
    refs: () => [local],
    async transferFirst(ctx, op, repo) {
      const demo = ctx.repos.get(repo);
      const prune = ctx.state.settings.prune ? '--prune' : '--no-prune';
      // The core's argv: `fetch <remote> --prune --no-prune-tags --progress`; git's reflog names it.
      let changed = false;
      try {
        changed = (await fetchInto(ctx, demo, o.remote, { prune: ctx.state.settings.prune, op, reflog: `fetch ${o.remote} ${prune} --no-prune-tags --progress` })).changed;
      } catch (e) {
        // Even a failed fetch may have moved some.
        if (movedBefore(e).length > 0) ctx.emit({ type: 'refsUpdated', repo });
        throw e;
      }
      if (changed) ctx.emit({ type: 'refsUpdated', repo });
    },
    async plan(pre) {
      const checkedOut = pre.before.head.branch === o.branch;
      if (!checkedOut) {
        if (o.mode !== 'ffOnly') fail('InvalidInput', `Check out ${o.branch} first`);
        const at = (await branchesElsewhere(pre.read, pre.root)).get(local);
        if (at !== undefined) fail('InvalidInput', `${o.branch} is checked out in ${at}`);
      }
      const mine = readRef(pre.repo, local) ?? fail('NotFound', `${o.branch} doesn't exist`);
      const theirs = readRef(pre.repo, upstreamRef) ?? fail('NotFound', `${upstream} doesn't exist`);
      const [ahead, behind] = await relation(pre.read, mine, theirs);
      planned = { checkedOut, local: mine, theirs, ahead, behind };
      if (!checkedOut || behind === 0) return {};
      // §6.1: a fast-forward autostashes on overlap only; a merge or rebase on any tracked change.
      if (ahead === 0) return { autostash: autostash('overlap', theirs) };
      if (o.mode === 'ffOnly') return {};
      if (o.mode === 'ffOrMerge') return { autostash: autostash('merged', theirs) };
      // The rebase's own checks (the lossy-merge refusal), with pull's stash.
      return { ...(await rebase.plan!(pre)), autostash: autostash('rebased', theirs) };
    },
    async run(cx) {
      const { checkedOut, local: mine, theirs, ahead, behind } = planned ?? fail('Other', 'pull ran without its plan');
      let result: PullResult;
      if (behind === 0) result = { status: 'upToDate', ahead };
      else if (ahead === 0 && !checkedOut) {
        // Deviation 13: the Sync row on a branch that isn't checked out: a CAS.
        await cx.cas([{ name: local, old: mine, new: theirs }], `pull ${upstream}: Fast-forward`);
        cx.touch('refs');
        result = { status: 'fastForward', commits: behind };
      } else if (ahead === 0) {
        // The core's own `git merge --ff-only` here, not `run_merge`: no `state` change.
        await runMerge(cx, upstreamRef, upstream, true, ['worktree', 'index', 'refs']);
        result = { status: 'fastForward', commits: behind };
      } else if (!checkedOut || o.mode === 'ffOnly') {
        result = { status: 'diverged', ahead, behind, conflicts: (await predictConflicts(cx.read, mine, theirs)).length };
      } else {
        let done;
        if (o.mode === 'rebase') {
          done = await rebase.run(cx);
          // The banner names the upstream as the user knows it.
          if (cx.paused) cx.paused = { ...cx.paused, target: upstream };
        } else done = await runMerge(cx, upstreamRef, upstream, false);
        result =
          done.status === 'stopped' ? { status: 'stopped', kind: done.kind, files: done.files, ...(done.warning ? { warning: done.warning } : {}) }
          : done.status === 'done' ? (o.mode === 'rebase' ? { status: 'rebased', commits: done.commits } : { status: 'merged', commits: done.commits })
          : { status: 'upToDate', ahead };
      }
      return { op: cx.op, branch: o.branch, upstream, server: { lines: 0, warning: null }, result };
    },
  };
}

/** The core's write/remotes.rs `AddRemote`: `git remote add`, config only (never the network, and not
 *  journaled: the core says Undo would be a Remove). The fetch that follows is its own request. */
export function addRemoteIntent(name: string, url: string): WriteIntent<null> {
  return {
    kind: 'branch',
    // Never the URL: it may carry credentials.
    label: () => `add remote ${name}`,
    undo: null,
    staging: 'keep',
    async plan(pre) {
      const bad = remoteNameError(name) ?? remoteUrlError(url);
      if (bad) fail('InvalidInput', bad);
      // Any `[remote "X"]` section counts, as the core's `remote_names()`, not only one with a url.
      const taken = (await pre.repo.remotes()).some((r) => r.name === name) || (await readLocalConfig(pre.read)).some(([k]) => isRemoteKey(k, name));
      if (taken) fail('InvalidInput', `A remote named ${name} already exists`);
      return {};
    },
    async run(cx) {
      await setConfigValues(cx.read, `remote.${name}.url`, [url]);
      await setConfigValues(cx.read, `remote.${name}.fetch`, [`+refs/heads/*:refs/remotes/${name}/*`]);
      cx.touch('config');
      return null;
    },
  };
}

/** A key `git remote remove` may change (the core's `removal_key`). */
const isRemovalKey = (key: string, name: string) =>
  isRemoteKey(key, name) || key === 'remote.pushdefault' || (key.startsWith('branch.') && ['.remote', '.merge', '.pushremote'].some((v) => key.endsWith(v)));

const grouped = (list: [string, string][]) => {
  const m = new Map<string, string[]>();
  for (const [k, v] of list) m.set(k, [...(m.get(k) ?? []), v]);
  return m;
};

/** The core's `RemoveRemote`: `git remote remove`, journaled: its tracking refs (and their reflogs),
 *  its `remote.<name>.*` keys, and the upstreams and push settings that name it. */
export function removeRemoteIntent(name: string): WriteIntent<null> {
  return {
    kind: 'branch',
    label: () => `remove remote ${name}`,
    undo: 'moveRefs',
    staging: 'keep',
    async plan(pre) {
      if ((await readLocalConfig(pre.read)).some(([k]) => isRemoteKey(k, name))) return {};
      // A stale remote (its tracking refs left behind).
      const prefix = `refs/remotes/${name}/`;
      if ([...pre.repo.refMap().keys()].some((n) => n.startsWith(prefix))) return {};
      return fail('NotFound', `No remote ${name}`);
    },
    async run(cx) {
      const before = await readLocalConfig(cx.read);
      const prefix = `refs/remotes/${name}/`;
      const refs = cx.repo.refMap();
      // A symbolic `<name>/HEAD` goes with the rest (the CAS names concrete refs): the entry keeps
      // it for Undo, and its reflog goes with it.
      const names = [...refs.keys()].filter((n) => n.startsWith(prefix));
      const symrefs = names.filter((n) => refs.get(n)!.symref !== null).map((n): [string, string] => [n, refs.get(n)!.symref!]);
      const moves = names.filter((n) => refs.get(n)!.symref === null).map((n) => ({ name: n, old: cx.repo.resolveRef(refs, n), new: null }));
      for (const [n] of symrefs) deleteRefFiles(cx.repo, n);
      if (moves.length) await cx.cas(moves, `remote: removed ${name}`);
      recordRemovedRemote(cx, name, symrefs);
      await removeConfigSection(cx.read, `remote.${name}`);
      const unset = new Set<string>();
      for (const [k, v] of before) {
        if (v !== name) continue;
        if (k === 'remote.pushdefault') unset.add(k);
        else if (k.startsWith('branch.') && k.endsWith('.remote')) {
          unset.add(k);
          unset.add(`${k.slice(0, -'.remote'.length)}.merge`);
        } else if (k.startsWith('branch.') && k.endsWith('.pushremote')) unset.add(k);
      }
      for (const k of [...unset].sort(compareBytewise)) await setConfigValues(cx.read, k, []);
      const was = grouped(before);
      const after = grouped(await readLocalConfig(cx.read));
      cx.recordConfig(
        [...new Set([...was.keys(), ...after.keys()])]
          .filter((k) => isRemovalKey(k, name))
          .map((key) => ({ key, old: was.get(key) ?? [], new: after.get(key) ?? [] }))
          .filter((c) => JSON.stringify(c.old) !== JSON.stringify(c.new)),
      );
      cx.touch('refs');
      cx.touch('config');
      return null;
    },
  };
}
