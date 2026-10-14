// Checkout (write/checkout.rs, spec #2 §9.3): the case is settled in `plan` from what preflight read,
// then the worktree moves (Task 10's two-way move, checked whole before anything is written) and
// only then the refs and HEAD, so a refused checkout changes nothing.
import type { CheckoutOutcome } from '../../api/gen/CheckoutOutcome';
import type { CheckoutTarget } from '../../api/gen/CheckoutTarget';
import type { HandlerTable } from '../transport';
import { objectsByPrefix, peelToCommit, relation } from '../engine/read/revs';
import { fail } from '../engine/read/seam';
import { checkedOutElsewhere, elsewhere } from '../engine/write/checkedOut';
import { branchConfig, configChanges } from '../engine/write/config';
import { twoWayMove } from '../engine/write/move';
import { setHead } from '../engine/write/refs';
import { runWrite, type Pre, type WriteCx, type WriteIntent } from '../engine/write/run';
import { heads, upstreamKeys, writeUpstream } from './branches';

export type CheckoutCase =
  | { kind: 'noop'; name: string }
  | { kind: 'switch'; name: string; to: string }
  | { kind: 'track'; name: string; remoteRef: string; to: string }
  | { kind: 'fastForward'; name: string; from: string; to: string }
  | { kind: 'mergeFfOnly'; to: string }
  | { kind: 'diverged'; name: string; remote: string; ahead: number; behind: number; localOid: string; remoteOid: string }
  | { kind: 'reset'; name: string; from: string; to: string; here: boolean }
  | { kind: 'detach'; oid: string };

export function movesTo(c: CheckoutCase): string | null {
  switch (c.kind) {
    case 'noop':
    case 'diverged':
      return null;
    case 'detach':
      return c.oid;
    default:
      return c.to;
  }
}

/** The first seven characters (never a byte slice). */
const short = (s: string) => [...s].slice(0, 7).join('');

/** A detached target as a full commit id: hex only (never a ref name), NotFound when it names no commit. */
async function commitOid(pre: Pre, given: string): Promise<string> {
  if (given.length < 4 || given.length > 64 || !/^[0-9a-fA-F]+$/.test(given)) fail('InvalidInput', `Not a commit id: ${short(given)}`);
  const spec = given.toLowerCase();
  const found = await objectsByPrefix(pre.wt.repo, spec.slice(0, 40));
  const commit = found.length === 1 ? await peelToCommit(pre.wt.repo, found[0]) : null;
  if (commit === null) fail('NotFound', `No commit ${short(spec)}`);
  return commit;
}

async function settle(pre: Pre, target: CheckoutTarget, onDiverged: 'reset' | null): Promise<CheckoutCase> {
  const read = (name: string) => pre.before.refs.get(name) ?? null;
  const hereBranch = pre.before.head.branch;
  if (target.kind === 'branch') {
    const to = read(heads(target.name));
    if (to === null) fail('NotFound', `No branch ${target.name}`);
    if (hereBranch === target.name) return { kind: 'noop', name: target.name };
    const shown = await elsewhere(pre.wt, heads(target.name));
    if (shown !== null) throw checkedOutElsewhere(target.name, shown);
    return { kind: 'switch', name: target.name, to };
  }
  if (target.kind === 'detached') return { kind: 'detach', oid: await commitOid(pre, target.oid) };
  const name = target.local ?? target.branch;
  const remoteRef = `refs/remotes/${target.remote}/${target.branch}`;
  const remote = `${target.remote}/${target.branch}`;
  const to = read(remoteRef);
  if (to === null) fail('NotFound', `No branch ${remote}`);
  const here = hereBranch === name;
  const local = read(heads(name));
  if (local === null) {
    // `git switch --track -c` refuses a ref of no configured remote; the core puts the worktree it
    // moved back, so nothing changes: refused here, before anything moves or is journaled.
    if ((await upstreamKeys(pre.wt.demo, remoteRef)) === null) fail('Other', `cannot set up tracking information; starting point '${remoteRef}' is not a branch`);
    return { kind: 'track', name, remoteRef, to };
  }
  if (!here) {
    const shown = await elsewhere(pre.wt, heads(name));
    if (shown !== null) throw checkedOutElsewhere(name, shown);
  }
  const [ahead, behind] = await relation(pre.wt.repo, local, to);
  if (behind === 0) return here ? { kind: 'noop', name } : { kind: 'switch', name, to: local };
  if (ahead === 0) return here ? { kind: 'mergeFfOnly', to } : { kind: 'fastForward', name, from: local, to };
  if (onDiverged === null) return { kind: 'diverged', name, remote, ahead, behind, localOid: local, remoteOid: to };
  // Review M2: the Reset is the one the question showed; preflight compared `expect` with the refs.
  const pinned = pre.expect.refs ?? {};
  if (!(heads(name) in pinned) || !(remoteRef in pinned)) fail('InvalidInput', `Reset ${name} needs the commits the question showed`);
  return { kind: 'reset', name, from: local, to, here };
}

const touchAll = (cx: WriteCx) => {
  for (const k of ['head', 'index', 'worktree'] as const) cx.touch(k);
};

function checkout(target: CheckoutTarget, onDiverged: 'reset' | null, confirmAutostash: boolean): WriteIntent<CheckoutOutcome> {
  let settled: CheckoutCase | null = null;
  const targetName = () =>
    target.kind === 'detached' ? short(settled?.kind === 'detach' ? settled.oid : target.oid) : target.kind === 'branch' ? target.name : `${target.remote}/${target.branch}`;
  return {
    kind: 'checkout',
    label: () => `checkout ${targetName()}`,
    undo: () => 'switch',
    refs: () => (target.kind === 'branch' ? [heads(target.name)] : target.kind === 'remote' ? [heads(target.local ?? target.branch), `refs/remotes/${target.remote}/${target.branch}`] : []),
    confirm: { autostash: confirmAutostash },
    plan: async (pre) => {
      settled = await settle(pre, target, onDiverged);
      // §6.1: autostash on overlap with the commit the worktree moves to.
      const to = movesTo(settled);
      return to === null ? {} : { autostash: { rule: { kind: 'overlap' }, target: to, op: `checkout ${targetName()}`, targetName: targetName() } };
    },
    run: async (cx) => {
      const c = settled!;
      const head = cx.before.head.oid;
      const done = (branch: string | null): CheckoutOutcome => ({ status: 'done', branch });
      switch (c.kind) {
        case 'noop':
          return done(c.name);
        case 'diverged':
          return { status: 'diverged', local: c.name, remote: c.remote, ahead: c.ahead, behind: c.behind, localOid: c.localOid, remoteOid: c.remoteOid };
        case 'switch':
          touchAll(cx);
          await twoWayMove(cx.wt, head, c.to, 'checkout');
          setHead(cx.wt, { branch: c.name });
          cx.command('switch', '--no-guess', c.name);
          return done(c.name);
        case 'track': {
          touchAll(cx);
          await twoWayMove(cx.wt, head, c.to, 'checkout');
          const demo = cx.wt.demo;
          const before = branchConfig(demo, c.name);
          cx.cas([{ name: heads(c.name), old: null, new: c.to }]);
          await writeUpstream(demo, c.name, c.remoteRef);
          cx.recordConfig(configChanges(before, branchConfig(demo, c.name)));
          setHead(cx.wt, { branch: c.name });
          cx.command('switch', '--no-guess', '--track', '-c', c.name, c.remoteRef);
          return done(c.name);
        }
        case 'fastForward':
          touchAll(cx);
          await twoWayMove(cx.wt, head, c.to, 'checkout');
          cx.cas([{ name: heads(c.name), old: c.from, new: c.to }]);
          setHead(cx.wt, { branch: c.name });
          cx.command('switch', '--no-guess', c.name);
          return done(c.name);
        case 'mergeFfOnly':
          cx.setUndo('rewind');
          touchAll(cx);
          await twoWayMove(cx.wt, head, c.to, 'merge');
          cx.cas([{ name: heads(cx.before.head.branch!), old: head, new: c.to }]);
          cx.command('merge', '--ff-only', '--no-autostash', '-q', c.to);
          return done(cx.before.head.branch);
        case 'reset':
          touchAll(cx);
          if (c.here) {
            cx.setUndo('rewind');
            await twoWayMove(cx.wt, c.from, c.to, 'readTree');
            cx.cas([{ name: heads(c.name), old: c.from, new: c.to }]);
            cx.command('read-tree', '-m', '-u', c.from, c.to);
          } else {
            await twoWayMove(cx.wt, head, c.to, 'checkout');
            cx.cas([{ name: heads(c.name), old: c.from, new: c.to }]);
            setHead(cx.wt, { branch: c.name });
            cx.command('switch', '--no-guess', c.name);
          }
          return done(c.name);
        case 'detach':
          touchAll(cx);
          await twoWayMove(cx.wt, head, c.oid, 'checkout');
          setHead(cx.wt, { oid: c.oid });
          cx.command('switch', '--detach', c.oid);
          return done(null);
      }
    },
  };
}

export const checkoutHandlers: Pick<HandlerTable, 'checkout'> = {
  checkout: async ({ repo, worktree, target, onDiverged, expect, confirmAutostash }, ctx) =>
    runWrite(ctx, repo, worktree, expect, checkout(target, onDiverged ?? null, confirmAutostash ?? false)),
};
