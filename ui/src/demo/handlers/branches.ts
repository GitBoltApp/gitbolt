// Branches and tags (write/branch.rs, write/branch_delete.rs, integrate.rs's FastForwardIntent,
// write/tags.rs): refs moved by CAS, `branch.<name>.*` edited as git edits it, journaled as the core
// journals them. The remote legs of a delete are a push (plan 4's engine/remote/sync.ts).
import type { DeleteOutcome } from '../../api/gen/DeleteOutcome';
import type { IntegrateOutcome } from '../../api/gen/IntegrateOutcome';
import type { RemoteBranchRef } from '../../api/gen/RemoteBranchRef';
import { branchNameError } from '../../branches/branchName';
import type { HandlerTable } from '../transport';
import { asGbError } from '../engine/errors';
import { relation, revParse } from '../engine/read/revs';
import { fail } from '../engine/read/seam';
import { readRaw } from '../engine/read/trees';
import { listWorktrees } from '../engine/read/worktrees';
import { deleteRemoteBranch, deleteRemoteTag } from '../engine/remote/sync';
import { remoteFor } from '../engine/remotes';
import type { DemoRepo } from '../engine/repo';
import { checkedOutElsewhere, displayWorktree } from '../engine/write/checkedOut';
import { branchConfig, configChanges, removeBranchSection, renameBranchSection, setConfigValues } from '../engine/write/config';
import { twoWayMove } from '../engine/write/move';
import { cleanupStrip, writeTagObject } from '../engine/write/objects';
import { readRef, refMoved, setHead, shortRef } from '../engine/write/refs';
import { runWrite, type WriteCx, type WriteIntent } from '../engine/write/run';
import { opHandle } from '../engine/writeSeam';
import { upstreamOf } from './commit';

export const heads = (name: string): string => `refs/heads/${name}`;
const tagRef = (name: string) => `refs/tags/${name}`;
/** The branch rules said of a tag (names::tag_name_error; the UI's tagName.ts reads the app's store). */
export const tagNameError = (name: string): string | null => branchNameError(name)?.replaceAll('branch', 'tag') ?? null;

/** A full commit id in this repository, as `create branch` and `create tag` take it. */
async function commitId(cx: { wt: { repo: Parameters<typeof readRaw>[0] } }, given: string): Promise<string> {
  if (!/^[0-9a-fA-F]{40}$/.test(given)) fail('InvalidInput', `not an object id: ${given}`);
  const oid = given.toLowerCase();
  if ((await readRaw(cx.wt.repo, oid))?.type !== 'commit') fail('InvalidInput', `${given} isn't a commit in this repository`);
  return oid;
}

export async function upstreamFor(demo: DemoRepo, startRef: string | null): Promise<string | null> {
  if (startRef === null) return null;
  const setting = ((await demo.config('branch.autoSetupMerge')) ?? '').trim().toLowerCase();
  const tracks = setting === 'false' ? false : setting === 'always' ? startRef.startsWith('refs/remotes/') || startRef.startsWith('refs/heads/') : startRef.startsWith('refs/remotes/');
  return tracks ? startRef : null;
}

/** `branch.<name>.remote` and `.merge` for an upstream; null when a remote-tracking ref belongs
 *  to no configured remote. */
export async function upstreamKeys(demo: DemoRepo, up: string): Promise<{ remote: string; merge: string } | null> {
  if (!up.startsWith('refs/remotes/')) return { remote: '.', merge: up };
  const rest = up.slice('refs/remotes/'.length);
  const r = remoteFor(rest, (await demo.remotes()).map((x) => x.name));
  return r === null ? null : { remote: r, merge: `refs/heads/${rest.slice(r.length + 1)}` };
}

/** `upstreamKeys`, refused as git refuses an upstream it can't name. */
export async function upstreamKeysOrFail(demo: DemoRepo, up: string): Promise<{ remote: string; merge: string }> {
  return (await upstreamKeys(demo, up)) ?? fail('InvalidInput', `the requested upstream branch '${shortRef(up)}' does not exist`);
}

export function writeUpstreamKeys(demo: DemoRepo, branch: string, keys: { remote: string; merge: string }): void {
  setConfigValues(demo, `branch.${branch}.remote`, [keys.remote]);
  setConfigValues(demo, `branch.${branch}.merge`, [keys.merge]);
}

export async function writeUpstream(demo: DemoRepo, branch: string, up: string): Promise<void> {
  writeUpstreamKeys(demo, branch, await upstreamKeysOrFail(demo, up));
}

function createBranch(name: string, start: string, startRef: string | null, checkout: boolean, confirmAutostash: boolean): WriteIntent<null> {
  return {
    kind: 'branch',
    label: () => `create branch ${name}`,
    undo: () => (checkout ? 'switch' : 'moveRefs'),
    refs: () => (branchNameError(name) ? [] : [heads(name)]),
    confirm: { autostash: confirmAutostash },
    plan: async (pre) => {
      const why = branchNameError(name);
      if (why) fail('InvalidInput', why);
      if (pre.before.refs.get(heads(name))) fail('InvalidInput', `A branch named ${name} already exists`);
      await commitId(pre, start);
      // §6.1: a checkout that moves the worktree autostashes on overlap.
      const moves = checkout && pre.before.head.oid !== start.toLowerCase();
      return moves ? { autostash: { rule: { kind: 'overlap' }, target: start.toLowerCase(), op: `checkout ${name}`, targetName: name } } : {};
    },
    run: async (cx) => {
      const oid = start.toLowerCase();
      const demo = cx.wt.demo;
      // The move first: it checks the whole tree before writing, so a refusal leaves no branch behind.
      if (checkout && cx.before.head.oid !== oid) await twoWayMove(cx.wt, cx.before.head.oid, oid, 'checkout');
      cx.cas([{ name: heads(name), old: null, new: oid }]);
      cx.touch('refs');
      const up = await upstreamFor(demo, startRef);
      if (up !== null) {
        const before = branchConfig(demo, name);
        await writeUpstream(demo, name, up);
        cx.recordConfig(configChanges(before, branchConfig(demo, name)));
        cx.command('branch', `--set-upstream-to=${up}`, name);
      }
      if (checkout) {
        for (const k of ['head', 'index', 'worktree'] as const) cx.touch(k);
        setHead(cx.wt, { branch: name });
        cx.command('switch', '--no-guess', name);
      }
      return null;
    },
  };
}

export async function renameBranchRefs(cx: WriteCx, from: string, to: string): Promise<void> {
  const demo = cx.wt.demo;
  const oid = readRef(demo, heads(from));
  if (oid === null) fail('NotFound', `No branch ${from}`);
  // Delete first: `feature` → `feature/x` is a rename git allows.
  cx.cas([{ name: heads(from), old: oid, new: null }]);
  cx.cas([{ name: heads(to), old: null, new: oid }]);
  renameBranchSection(demo, from, to);
  for (const w of await listWorktrees(cx.wt.repo)) if (w.branch === heads(from)) demo.fs.writeFileSync(`${w.gitdir}/HEAD`, `ref: refs/heads/${to}\n`);
  const log = `${demo.gitdir}/logs/refs/heads/${from}`;
  if (demo.fs.existsSync(log, false)) {
    const target = `${demo.gitdir}/logs/refs/heads/${to}`;
    demo.fs.mkdirpSync(target.slice(0, target.lastIndexOf('/')));
    demo.fs.writeFileSync(target, demo.fs.readFileSync(log) as Uint8Array);
    demo.fs.unlinkSync(log);
  }
  for (const k of ['refs', 'config', 'head'] as const) cx.touch(k);
  cx.command('branch', '-m', from, to);
}

function renameBranch(from: string, to: string): WriteIntent<null> {
  return {
    kind: 'branch',
    label: () => `rename branch ${from} to ${to}`,
    undo: () => 'rename',
    refs: () => (branchNameError(to) || branchNameError(from) ? [] : [heads(from), heads(to)]),
    plan: async (pre) => {
      const why = branchNameError(to);
      if (why) fail('InvalidInput', why);
      if (!pre.before.refs.get(heads(from))) fail('NotFound', `No branch ${from}`);
      if (pre.before.refs.get(heads(to))) fail('InvalidInput', `A branch named ${to} already exists`);
      return {};
    },
    run: async (cx) => {
      await renameBranchRefs(cx, from, to);
      return null;
    },
  };
}

function setUpstream(branch: string, upstream: { remote: string; branch: string } | null): WriteIntent<null> {
  return {
    kind: 'branch',
    label: () => `set upstream of ${branch}`,
    undo: () => null,
    plan: async (pre) => {
      const why = branchNameError(branch);
      if (why) fail('InvalidInput', why);
      if (readRef(pre.wt.demo, heads(branch)) === null) fail('NotFound', `No branch ${branch}`);
      if (upstream) {
        const bad = branchNameError(upstream.branch);
        if (bad) fail('InvalidInput', bad);
        const names = (await pre.wt.demo.remotes()).map((r) => r.name);
        if (upstream.remote.startsWith('-') || !names.includes(upstream.remote)) fail('NotFound', `No remote ${upstream.remote}`);
      }
      return {};
    },
    run: async (cx) => {
      const demo = cx.wt.demo;
      cx.touch('config');
      if (upstream === null) {
        setConfigValues(demo, `branch.${branch}.remote`, []);
        setConfigValues(demo, `branch.${branch}.merge`, []);
        cx.command('branch', '--unset-upstream', '--', branch);
        return null;
      }
      // An existing tracking ref, or a branch the next push creates (§9.1): the same two keys.
      setConfigValues(demo, `branch.${branch}.remote`, [upstream.remote]);
      setConfigValues(demo, `branch.${branch}.merge`, [`refs/heads/${upstream.branch}`]);
      cx.command('branch', `--set-upstream-to=refs/remotes/${upstream.remote}/${upstream.branch}`, '--', branch);
      return null;
    },
  };
}

/** A failure of the local part after the remote one went: it says what's already gone. */
function afterRemote(e: unknown, gone: string | null, what: string): never {
  const err = asGbError(e);
  throw gone === null ? err : { ...err, message: `Deleted ${gone}; deleting the ${what} failed: ${err.message}` };
}

/** Local, remote or both (branch_delete.rs): the remote first, its lease the tracking oid the UI
 *  showed, outside the write lock; a Both puts the push's Barrier below its own entry. */
function deleteBranch(branch: string, local: boolean, remote: RemoteBranchRef | null, force: boolean): WriteIntent<DeleteOutcome> {
  const full = heads(branch);
  const shown = remote && `${remote.remote}/${remote.branch}`;
  let unmerged: { into: string; commits: number } | null = null;
  return {
    kind: local ? 'branch' : 'push',
    label: () => (shown === null ? `delete branch ${branch}` : local ? `delete branch ${branch} and ${shown}` : `delete ${shown}`),
    undo: () => (local ? 'moveRefs' : 'barrier'),
    refs: () => (local ? [full] : []),
    plan: async (pre) => {
      if (!local && remote === null) fail('InvalidInput', 'Nothing to delete');
      if (remote !== null) {
        const tracking = `refs/remotes/${remote.remote}/${remote.branch}`;
        if (readRef(pre.wt.demo, tracking) !== remote.lease) throw refMoved(tracking);
      }
      if (!local) return {};
      const tip = pre.before.refs.get(full) ?? null;
      if (tip === null) fail('NotFound', 'No local branch');
      const all = await listWorktrees(pre.wt.repo);
      const w = all.find((x) => x.branch === full);
      if (w) {
        if (w.path === pre.wt.root) fail('InvalidInput', `${branch} is checked out`);
        throw checkedOutElsewhere(branch, displayWorktree(all.find((m) => m.isMain)?.path ?? pre.wt.repo.dir, w.path));
      }
      if (!force) {
        // Its upstream, unless that's being deleted too; else HEAD.
        const up = remote !== null ? null : await upstreamOf(pre.wt.demo, branch);
        const upOid = up === null ? null : readRef(pre.wt.demo, up);
        const intoOid = upOid ?? pre.before.head.oid;
        if (intoOid === null) fail('NotFound', `bad revision '${up ?? 'HEAD'}..${full}'`); // rev-list on an unborn HEAD
        const commits = (await relation(pre.wt.repo, tip, intoOid))[0];
        if (commits > 0) {
          const head = pre.before.head;
          unmerged = { into: upOid !== null ? shortRef(up!) : (head.branch ?? head.oid?.slice(0, 7) ?? 'HEAD'), commits };
        }
      }
      return {};
    },
    run: async (cx) => {
      if (unmerged) return { status: 'unmerged', branch, into: unmerged.into, commits: unmerged.commits };
      const demo = cx.wt.demo;
      if (remote !== null) {
        await cx.network(() => deleteRemoteBranch(cx.ctx, demo, remote.remote, remote.branch, { lease: remote.lease, op: opHandle(cx.ctx, cx.op) }));
        cx.touch('refs');
        if (local) {
          cx.barrierBelow(`delete ${shown}`, 'push');
          cx.setNote(`${shown} stays deleted`);
        }
      }
      if (!local) return { status: 'deleted' };
      try {
        const before = branchConfig(demo, branch);
        cx.cas([{ name: full, old: cx.before.refs.get(full) ?? null, new: null }]);
        cx.touch('refs');
        if (before.size > 0) {
          removeBranchSection(demo, branch);
          cx.recordConfig(configChanges(before, new Map()));
          cx.command('config', '--local', '--remove-section', `branch.${branch}`);
        }
      } catch (e) {
        afterRemote(e, shown, 'local branch');
      }
      return { status: 'deleted' };
    },
  };
}

function fastForward(branch: string, to: string): WriteIntent<IntegrateOutcome> {
  const name = heads(branch);
  return {
    kind: 'branch',
    label: () => `fast-forward ${branch} to ${shortRef(to)}`,
    undo: () => 'moveRefs',
    refs: () => [name],
    run: async (cx) => {
      const w = (await listWorktrees(cx.wt.repo)).find((x) => x.branch === name);
      if (w) fail('InvalidInput', `${branch} is checked out in ${w.path}`);
      const target = await revParse(cx.wt.repo, to, cx.wt.root);
      const old = cx.before.refs.get(name) ?? null;
      if (old === null) fail('NotFound', `${branch} doesn't exist`);
      if (old === target) return { status: 'upToDate' };
      const [commits, missing] = await relation(cx.wt.repo, target, old);
      if (missing > 0) fail('NonFastForward', `${branch} has commits ${shortRef(to)} doesn't have`);
      cx.cas([{ name, old, new: target }]);
      cx.touch('refs');
      return { status: 'done', commits, fastForward: true };
    },
  };
}

function createTag(name: string, target: string, message: string | null): WriteIntent<null> {
  return {
    kind: 'branch',
    label: () => `create tag ${name}`,
    undo: () => 'moveRefs',
    staging: 'keep',
    refs: () => (tagNameError(name) ? [] : [tagRef(name)]),
    plan: async (pre) => {
      const why = tagNameError(name);
      if (why) fail('InvalidInput', why);
      if (pre.before.refs.get(tagRef(name))) fail('InvalidInput', `A tag named ${name} already exists`);
      if (message !== null && message.trim() === '') fail('InvalidInput', 'Enter a tag message');
      await commitId(pre, target);
      return {};
    },
    run: async (cx) => {
      const oid = target.toLowerCase();
      if (message === null) cx.cas([{ name: tagRef(name), old: null, new: oid }]);
      else {
        const tag = await writeTagObject(cx.wt.repo, { object: oid, name, tagger: cx.ident(), message: cleanupStrip(`${message.trimEnd()}\n`) });
        cx.cas([{ name: tagRef(name), old: null, new: tag }]);
        cx.command('tag', '-a', '-F', '-', '--', name, oid);
      }
      cx.touch('refs');
      return null;
    },
  };
}

/** Local, remote (`git push <remote> :refs/tags/<t>`, outside the write lock) or both, the remote
 *  first (tags.rs `DeleteTag`). */
function deleteTag(name: string, local: boolean, remote: string | null): WriteIntent<null> {
  return {
    kind: local ? 'branch' : 'push',
    label: () => (remote === null ? `delete tag ${name}` : local ? `delete tag ${name} here and from ${remote}` : `delete tag ${name} from ${remote}`),
    undo: () => (local ? 'moveRefs' : 'barrier'),
    staging: 'keep',
    refs: () => (local ? [tagRef(name)] : []),
    plan: async (pre) => {
      if (!local && remote === null) fail('InvalidInput', 'Nothing to delete');
      if (local && !pre.before.refs.get(tagRef(name))) fail('NotFound', `No tag ${name}`);
      return {};
    },
    run: async (cx) => {
      if (remote !== null) {
        await cx.network(() => deleteRemoteTag(cx.ctx, cx.wt.demo, remote, name, { op: opHandle(cx.ctx, cx.op) }));
        cx.touch('refs');
        if (local) {
          cx.barrierBelow(`delete tag ${name} from ${remote}`, 'push');
          cx.setNote(`${name} stays deleted from ${remote}`);
        }
      }
      if (!local) return null;
      try {
        cx.cas([{ name: tagRef(name), old: cx.before.refs.get(tagRef(name)) ?? null, new: null }]);
      } catch (e) {
        afterRemote(e, remote === null ? null : `${name} from ${remote}`, 'local tag');
      }
      cx.touch('refs');
      return null;
    },
  };
}

export const branchHandlers: Pick<HandlerTable, 'createBranch' | 'renameBranch' | 'setUpstream' | 'deleteBranch' | 'fastForward' | 'createTag' | 'deleteTag'> = {
  createBranch: async ({ repo, worktree, name, start, startRef, checkout, expect, confirmAutostash }, ctx) =>
    runWrite(ctx, repo, worktree, expect, createBranch(name, start, startRef ?? null, checkout, confirmAutostash ?? false)),
  renameBranch: async ({ repo, worktree, from, to, expect }, ctx) => runWrite(ctx, repo, worktree, expect, renameBranch(from, to)),
  setUpstream: async ({ repo, worktree, branch, upstream }, ctx) => runWrite(ctx, repo, worktree, { head: null, refs: {} }, setUpstream(branch, upstream)),
  deleteBranch: async ({ repo, worktree, branch, local, remote, force, expect }, ctx) => runWrite(ctx, repo, worktree, expect, deleteBranch(branch, local, remote, force)),
  fastForward: async ({ repo, worktree, branch, to, expect }, ctx) => runWrite(ctx, repo, worktree, expect, fastForward(branch, to)),
  createTag: async ({ repo, worktree, name, target, message }, ctx) => runWrite(ctx, repo, worktree, { head: null, refs: {} }, createTag(name, target, message ?? null)),
  deleteTag: async ({ repo, worktree, name, local, remote }, ctx) => runWrite(ctx, repo, worktree, { head: null, refs: {} }, deleteTag(name, local, remote ?? null)),
};
