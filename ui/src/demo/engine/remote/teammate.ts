// The scripted teammate (spec §4.2): Orbital's origin holds a commit its `main` doesn't have yet
// (plan 2: `refs/demo/teammate`). It lands on the origin's `main` a short while into the visit, or
// just before the visitor's first fetch, pull or push of that origin, so Fetch has something to
// bring in. Never an overwrite of a moved `main`: once the visitor moved `main` elsewhere, the teammate gives up.
// Only a ref moves (the commit's objects are already in the origin), so a fetch's closure read can
// never see a half-written history.
import * as git from 'isomorphic-git';
import type { DemoContext } from '../../context';
import type { MemFs } from '../memfs';
import { demoRoot } from '../paths';
import { readRefFiles } from '../refs';
import { netOf } from './network';
import { readCommitIn } from './objects';

export const TEAMMATE_REF = 'refs/demo/teammate';
export const TEAMMATE_DELAY_MS = 30_000;

/** Pushes the origin's `main..refs/demo/teammate` to `main` when `main` is still where it sits; then drops the ref. The move, or null: not pushed. */
export async function teammatePush(fs: MemFs, origin: string): Promise<{ old: string; new: string } | null> {
  const refs = new Map(readRefFiles(fs, origin).map((r) => [r.full, r.oid]));
  const theirs = refs.get(TEAMMATE_REF);
  const main = refs.get('refs/heads/main');
  if (!theirs || !main) return null;
  // Walk back from the teammate's tip along first parents; main must be on that line.
  let at: string | undefined = theirs;
  for (let i = 0; i < 50 && at && at !== main; i++) {
    const c: { parent: string[] } | null = await readCommitIn(fs, origin, at).catch(() => null);
    at = c?.parent[0];
  }
  await git.deleteRef({ fs, gitdir: origin, ref: TEAMMATE_REF });
  if (at !== main) return null;
  // The walk awaited: re-read main so a concurrent push (the timer and the hook) can't be undone.
  if (readRefFiles(fs, origin).find((r) => r.full === 'refs/heads/main')?.oid !== main) return null;
  await git.writeRef({ fs, gitdir: origin, ref: 'refs/heads/main', value: theirs, force: true });
  return { old: main, new: theirs };
}

/** The teammate's push, and what any push tells the origin's listeners (the forge's: the open MRs
 *  into `main` see their new base). A failure never fails the visitor's fetch or push. */
async function land(ctx: DemoContext, fs: MemFs, origin: string): Promise<void> {
  try {
    const moved = await teammatePush(fs, origin);
    if (moved) for (const hook of netOf(ctx).afterPush) await hook(fs, origin, [{ ref: 'refs/heads/main', ...moved }]);
  } catch {
    // the visit goes on without it
  }
}

const started = new WeakSet<DemoContext>();

/** Arms the teammate: after `TEAMMATE_DELAY_MS`, and before the first network op of an origin, whichever comes first. */
export function startTeammate(ctx: DemoContext, fs: MemFs): void {
  if (started.has(ctx)) return;
  started.add(ctx);
  const net = netOf(ctx);
  net.beforeNetwork.push((f, gitdir) => land(ctx, f, gitdir));
  net.schedule(TEAMMATE_DELAY_MS, () => {
    void (async () => {
      for (const r of ctx.repos.manifest.repos) if (ctx.repos.loaded(r.name)) await land(ctx, fs, demoRoot(r.name, 'origin.git'));
    })();
  });
}
