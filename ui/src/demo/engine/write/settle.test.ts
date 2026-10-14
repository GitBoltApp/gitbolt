import { describe, expect, it } from 'vitest';
import { readCommit } from '../read/commitText';
import { fakeCtx, GRACE, makeTestRepo } from '../read/testkit';
import { rawAuthor, writeCommitObject } from './objects';
import { readRef, type RefMove } from './refs';
import { runWrite, type Pause } from './run';

const NO = { head: null, refs: {} };

/** main: Base, Main (m.txt), Grace's pick (p.txt). feature: Base, F1 (f.txt, by the visitor's clock).
 *  HEAD on feature; a `chip` branch at F1. */
async function setup() {
  const t = await makeTestRepo();
  await t.write('a.txt', 'a\n');
  const base = await t.commit('Base');
  await t.branch('feature', base);
  await t.write('m.txt', 'm\n');
  const main = await t.commit('Main');
  await t.write('p.txt', 'p\n');
  const pick = await t.commit('Pick', GRACE);
  await t.checkout('feature');
  await t.write('f.txt', 'f\n');
  const f1 = await t.commit('F1');
  await t.branch('chip', f1);
  const ctx = fakeCtx(t.repo);
  const recorded: [string | null, RefMove[]][] = [];
  ctx.writes.recordRewrite = async (_r, kind, moves) => void (kind && recorded.push([kind, moves]));
  const gitdir = t.repo.gitdir;
  /** A write that stops as `p` with the rebase's (or pick's) state on disk. */
  const pause = async (p: Pause) => {
    const r = await runWrite(ctx, 1, t.dir, NO, {
      kind: 'rebase', label: () => `${p.kind} feature`, undo: () => 'rewind', refs: () => ['refs/heads/chip'],
      run: async (cx) => {
        t.memfs.mkdirpSync(`${gitdir}/rebase-merge`);
        cx.paused = p;
        return null;
      },
    });
    return r.journal.paused!;
  };
  /** A commit like `like` (its author as stored) on `parent`. */
  const commitLike = async (like: string, parent: string, message = 'x\n') =>
    writeCommitObject(t.repo, { tree: (await readCommit(t.repo, like)).tree, parents: [parent], author: await rawAuthor(t.repo, like), committer: 'You <you@example.com> 1800000000 +0000', message });
  /** The op ends: its state goes, and feature (and chip) move as given, by `inside` GitVolt's own write or outside it. */
  const end = async (inside: boolean, feature: string, chip?: string | null) => {
    const move = () => {
      t.memfs.rmdirSync(`${gitdir}/rebase-merge`);
      const fs = t.memfs;
      fs.writeFileSync(`${gitdir}/refs/heads/feature`, `${feature}\n`);
      if (chip === null) fs.unlinkSync(`${gitdir}/refs/heads/chip`);
    };
    if (!inside) move();
    await runWrite(ctx, 1, t.dir, NO, { kind: 'resolve', label: () => 'continue', undo: () => null, allowedInProgress: true, run: async () => (inside ? move() : undefined, null) });
  };
  return { t, ctx, base, main, pick, f1, recorded, pause, commitLike, end };
}

describe('a paused rebase or pick settles as the core does', () => {
  it('a rebase completed by Continue is done, with the moves its session recorded, and a rewrite', async () => {
    const s = await setup();
    const chipMove = { name: 'refs/heads/chip', old: s.f1, new: null };
    const p = await s.pause({ kind: 'rebase', target: 'main', targetOid: s.pick, picked: [], irebase: { made: [], moved: [chipMove] } });
    expect(p.irebase).toBe(true);
    const rebased = await s.commitLike(s.f1, s.pick);
    await s.end(true, rebased, null);
    const e = s.ctx.writes.journal(s.t.dir).entry(p.entry)!;
    expect([e.state, e.refs]).toEqual(['done', [{ name: 'refs/heads/feature', old: s.f1, new: rebased }, chipMove]]);
    expect(s.recorded).toEqual([['rebase', e.refs]]);
    expect(readRef(s.t.repo.demo!, 'refs/heads/chip')).toBeNull();
  });

  it("a rebase ended outside GitVolt counts only if it kept the branch's own commits", async () => {
    const s = await setup();
    // Reset onto the target outside: the branch is the target itself, which only GitVolt's Continue can complete.
    let p = await s.pause({ kind: 'rebase', target: 'main', targetOid: s.pick, picked: [], irebase: null });
    await s.end(false, s.pick);
    expect(s.ctx.writes.journal(s.t.dir).entry(p.entry)).toBeNull();
    s.t.memfs.writeFileSync(`${s.t.repo.gitdir}/refs/heads/feature`, `${s.f1}\n`);
    // Someone else's commit on the target isn't the branch's.
    p = await s.pause({ kind: 'rebase', target: 'main', targetOid: s.main, picked: [], irebase: null });
    await s.end(false, await s.commitLike(s.pick, s.main));
    expect(s.ctx.writes.journal(s.t.dir).entry(p.entry)).toBeNull();
    expect(s.recorded).toEqual([]);
  });

  it('an aborted interactive rebase still keeps the moves its Continue made', async () => {
    const s = await setup();
    const chipMove = { name: 'refs/heads/chip', old: s.f1, new: null };
    const p = await s.pause({ kind: 'rebase', target: 'main', targetOid: s.pick, picked: [], irebase: { made: [], moved: [chipMove] } });
    await s.end(false, s.f1, null);
    const e = s.ctx.writes.journal(s.t.dir).entry(p.entry)!;
    expect([e.state, e.refs, e.headAfter]).toEqual(['done', [chipMove], e.headBefore]);
    expect(s.recorded).toEqual([]);
  });

  it("a cherry-pick completes with the picked commits only; a revert outside GitVolt only when each says what it reverts", async () => {
    const s = await setup();
    let p = await s.pause({ kind: 'cherryPick', target: 'Pick', targetOid: s.pick, picked: [s.pick], irebase: null });
    const picked = await s.commitLike(s.pick, s.f1);
    await s.end(false, picked);
    expect(s.ctx.writes.journal(s.t.dir).entry(p.entry)?.refs).toEqual([{ name: 'refs/heads/feature', old: s.f1, new: picked }]);
    // An abort, then new work of the visitor's: aborted.
    p = await s.pause({ kind: 'cherryPick', target: 'Pick', targetOid: s.pick, picked: [s.pick], irebase: null });
    await s.end(false, await s.commitLike(s.f1, picked));
    expect(s.ctx.writes.journal(s.t.dir).entry(p.entry)).toBeNull();
    const tip = readRef(s.t.repo.demo!, 'refs/heads/feature')!;
    p = await s.pause({ kind: 'revert', target: 'Pick', targetOid: s.pick, picked: [s.pick], irebase: null });
    await s.end(false, await s.commitLike(s.f1, tip, 'Reworded\n'));
    expect(s.ctx.writes.journal(s.t.dir).entry(p.entry)).toBeNull();
    // GitVolt's own Continue may commit a rewritten message: one commit, as many as it reverts.
    const aborted = readRef(s.t.repo.demo!, 'refs/heads/feature')!;
    p = await s.pause({ kind: 'revert', target: 'Pick', targetOid: s.pick, picked: [s.pick], irebase: null });
    await s.end(true, await s.commitLike(s.f1, aborted, 'Reworded again\n'));
    expect(s.ctx.writes.journal(s.t.dir).entry(p.entry)?.state).toBe('done');
    const after = readRef(s.t.repo.demo!, 'refs/heads/feature')!;
    p = await s.pause({ kind: 'revert', target: 'Pick', targetOid: s.pick, picked: [s.pick], irebase: null });
    await s.end(false, await s.commitLike(s.f1, after, `Revert "Pick"\n\nThis reverts commit ${s.pick.slice(0, 9)}.\n`));
    expect(s.ctx.writes.journal(s.t.dir).entry(p.entry)?.state).toBe('done');
  });
});
