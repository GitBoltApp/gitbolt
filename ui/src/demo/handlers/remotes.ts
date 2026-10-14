// Fetch, pull, push, tag pushes and remotes (plan 4).
import type { FetchOutcome } from '../../api/gen/FetchOutcome';
import type { GbError } from '../../api/gen/GbError';
import type { MrHead } from '../../api/gen/MrHead';
import { asGbError, NOT_IN_DEMO } from '../engine/errors';
import { fail, viewOf } from '../engine/read/seam';
import { worktreeOf } from '../engine/read/worktrees';
import { branchesElsewhere } from '../engine/seq/range';
import { redact } from '../engine/remotes';
import { addRemoteIntent, pullIntent, pushIntent, pushTagsIntent, removeRemoteIntent } from '../engine/remote/sync';
import { COMPARE_REFS, fetchInto, movedBefore } from '../engine/remote/transfer';
import { pushTarget } from '../engine/sidebar';
import { beginOp, inProgressName, NO_EXPECT, nowSeconds, runWrite, updateRef, withQueueSlot, type OpHandle } from '../engine/writeSeam';
import type { DemoContext } from '../context';
import type { HandlerTable } from '../transport';

/** The core's `MrHead::refspec` / `local_ref`. */
const mrRefs = (m: MrHead, remote: string) =>
  m.kind === 'gitlab'
    ? { src: `refs/merge-requests/${m.number}/head`, dst: `${COMPARE_REFS}${remote}/mr/${m.number}` }
    : { src: `refs/pull/${m.number}/head`, dst: `${COMPARE_REFS}${remote}/pr/${m.number}` };

/** A failed remote's short reason (the core's `fetch_reason`): the demo's only failure is a remote
 *  it can't reach. */
const reasonOf = (e: GbError) => (e.message.startsWith(NOT_IN_DEMO) ? 'not in the demo' : e.message);

/** The core's netops.rs `fetch_remote`: one remote (named last, after the options), or every one;
 *  a user's fetch holds the queue's running slot, a background one runs only while it is idle. */
async function fetchRepo(ctx: DemoContext, repo: number, background: boolean, remote: string | undefined, mrHead: MrHead | undefined): Promise<FetchOutcome> {
  if (mrHead && remote === undefined) fail('InvalidInput', "Fetching a merge request's head needs its remote");
  const demo = ctx.repos.get(repo);
  const names = (await demo.remotes()).map((r) => r.name);
  if (remote !== undefined && !names.includes(remote)) fail('NotFound', `No remote ${remote}`);
  const prune = ctx.state.settings.prune;
  const extra = mrHead && remote !== undefined ? mrRefs(mrHead, remote) : undefined;
  const options = [prune ? '--prune' : '--no-prune', '--no-prune-tags', ...(background ? ['--no-write-fetch-head'] : [])];
  const args = ['fetch', ...options, '--progress', ...(remote !== undefined ? ['--end-of-options', remote, ...(extra ? [`+${extra.src}:${extra.dst}`] : [])] : ['--all'])];
  const command = redact(`git ${args.join(' ')}`);
  const targets = remote !== undefined ? [remote] : names;
  // What git's reflog names (checked on the binary): the command itself, but each of several
  // remotes under `--all` is a child fetch of its own, with that child's argv.
  const reflogOf = (n: string) => (targets.length > 1 ? ['fetch', '--append', '--no-auto-gc', '--no-write-commit-graph', ...options, n] : args).join(' ');
  const op = beginOp(ctx);

  const run = async (): Promise<FetchOutcome> => {
    ctx.emit({ type: 'opStarted', op: op.id, kind: 'fetch', repo, label: demo.name, interactive: !background });
    let changed = false;
    try {
      const failed: { name: string; error: GbError }[] = [];
      for (const n of targets) {
        // git's progress line for each of several remotes.
        if (targets.length > 1) ctx.emit({ type: 'opProgress', op: op.id, phase: `Fetching ${n}`, percent: null });
        try {
          changed = (await fetchInto(ctx, demo, n, { prune, ...(extra ? { extra } : {}), op, reflog: reflogOf(n) })).changed || changed;
        } catch (e) {
          if (movedBefore(e).length > 0) changed = true;
          const err = asGbError(e);
          if (err.kind === 'Cancelled' || targets.length === 1) throw err;
          failed.push({ name: n, error: err });
        }
      }
      // One Compare at a time: the MR heads fetched before it go.
      if (extra) {
        const refs = demo.refMap();
        for (const [name] of refs) {
          if (!name.startsWith(COMPARE_REFS) || name === extra.dst) continue;
          // A delete writes no reflog.
          await updateRef(viewOf(demo), demo.gitdir, name, demo.resolveRef(refs, name), null, '', nowSeconds(ctx));
          changed = true;
        }
      }
      // git goes on past a remote it can't fetch; the first one's message, each named with its reason.
      if (failed.length > 0) throw { ...failed[0].error, detail: { kind: 'fetchFailed', remotes: failed.map((f) => ({ name: f.name, reason: reasonOf(f.error) })) } } satisfies GbError;
      if (changed) ctx.emit({ type: 'refsUpdated', repo });
      ctx.emit({ type: 'opFinished', op: op.id, kind: 'fetch', repo, outcome: 'ok', message: null, command });
      return { status: 'done', changed, server: { lines: 0, warning: null }, op: op.id };
    } catch (e) {
      const err = asGbError(e);
      // The demo has no watcher to tell the remotes fetched before the failure moved.
      if (changed) ctx.emit({ type: 'refsUpdated', repo });
      // A background fetch a user op cancelled: the next interval retries; nothing to show.
      if (err.kind === 'Cancelled' && background) {
        ctx.emit({ type: 'opFinished', op: op.id, kind: 'fetch', repo, outcome: 'skipped', message: null, command });
        return { status: 'skipped', reason: 'busy' };
      }
      ctx.emit({ type: 'opFinished', op: op.id, kind: 'fetch', repo, outcome: err.kind === 'Cancelled' ? 'cancelled' : 'failed', message: err.message, command });
      throw err;
    }
  };

  if (!background) return withQueueSlot(ctx, repo, `fetch ${demo.name}`, 'fetch', op.id, run);
  return runInBackground(ctx, repo, op, run);
}

/** A background fetch isn't a queue item: it runs only while the queue is idle (else it's skipped,
 *  no op started), and an item enqueued meanwhile cancels it. */
async function runInBackground(ctx: DemoContext, repo: number, op: OpHandle, run: () => Promise<FetchOutcome>): Promise<FetchOutcome> {
  try {
    const slot = ctx.writes.queue(repo, ctx.emit).tryBackground(() => ctx.writes.cancel(op.id));
    if (!slot) return { status: 'skipped', reason: 'busy' };
    try {
      return await run();
    } finally {
      slot.end();
    }
  } finally {
    ctx.writes.ended(op.id);
  }
}

export const remoteHandlers: Pick<HandlerTable, 'fetch' | 'pull' | 'push' | 'pushTags' | 'addRemote' | 'removeRemote'> = {
  fetch: ({ repo, background, remote, mrHead }, ctx) => fetchRepo(ctx, repo, background, remote, mrHead),
  // The core's sync.rs `push`: the click's target resolved (refused when there is none), then the write.
  push: async ({ repo, worktree, branch, target, setUpstream, lease, expect }, ctx) => {
    const shown = target ?? (await pushTarget(ctx.repos.get(repo), branch)) ?? fail('InvalidInput', `${branch} has no upstream; set one from Push ▾`);
    return runWrite(ctx, repo, worktree, expect, pushIntent({ branch, ...(target ? { target } : {}), setUpstream: setUpstream ?? false, ...(lease ? { lease } : {}), shown }));
  },
  // The core's sync.rs `pull`: every check that needs no write comes before anything runs (the
  // fetch is a network round trip), then the write.
  pull: async ({ repo, worktree, branch, mode, expect, confirm }, ctx) => {
    const demo = ctx.repos.get(repo);
    const here = await worktreeOf(viewOf(demo), worktree);
    const busy = inProgressName(demo.fs, here.gitdir);
    if (busy !== null) fail('InProgress', `A ${busy} is in progress`);
    const name = branch ?? here.branch?.replace(/^refs\/heads\//, '') ?? fail('InvalidInput', 'HEAD is detached; check out a branch to pull');
    const remote = await demo.config(`branch.${name}.remote`);
    const merge = (await demo.configAll(`branch.${name}.merge`))[0];
    if (remote === null || remote === '.' || merge === undefined) fail('InvalidInput', `${name} has no upstream; set one from Push ▾`);
    const checkedOut = here.branch === `refs/heads/${name}`;
    if (!checkedOut) {
      if (mode !== 'ffOnly') fail('InvalidInput', `Check out ${name} first`);
      const at = (await branchesElsewhere(viewOf(demo), here.path)).get(`refs/heads/${name}`);
      if (at !== undefined) fail('InvalidInput', `${name} is checked out in ${at}`);
    }
    return runWrite(ctx, repo, worktree, expect, pullIntent({ branch: name, remote, merge, mode, confirm, checkedOut }));
  },
  pushTags: ({ repo, worktree, remote, tag }, ctx) => runWrite(ctx, repo, worktree, NO_EXPECT, pushTagsIntent({ remote, tag: tag ?? null })),
  addRemote: ({ repo, worktree, name, url }, ctx) => runWrite(ctx, repo, worktree, NO_EXPECT, addRemoteIntent(name, url)),
  removeRemote: ({ repo, worktree, name }, ctx) => runWrite(ctx, repo, worktree, NO_EXPECT, removeRemoteIntent(name)),
};
