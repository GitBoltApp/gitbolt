// Test-only: the core's rebase fixtures (crates/gitvolt-core/src/testing/fixtures.rs: rebase_lab,
// irebase, stack) on 1b's in-memory test repository. Same shapes and subjects; the file names of
// the core's `r.commit(msg)` are this kit's own.
import { readCommit } from '../read/commitText';
import { revParse } from '../read/revs';
import * as git from 'isomorphic-git';
import type { TestRepo } from '../read/testkit';
import { DEMO_IDENTITY } from '../write/objects';

const counters = new WeakMap<TestRepo, number>();
/** A commit adding `file_<n>.txt` (n counts per repository from 1) holding the subject. */
async function touch(t: TestRepo, message: string): Promise<string> {
  const n = (counters.get(t) ?? 0) + 1;
  counters.set(t, n);
  await t.write(`file_${n}.txt`, `${message}\n`);
  return t.commit(message);
}

/** Six commits on `lab` (L2 rewrites line two, which main also edits; L4 edits L3's line). HEAD: lab. */
export async function rebaseLab(t: TestRepo): Promise<void> {
  await t.write('notes.txt', 'one\ntwo\nthree\n');
  await t.commit('Base');
  await t.branch('lab');
  await t.checkout('lab');
  await touch(t, 'L1 Add parser');
  await t.write('notes.txt', 'one\ntwo, lab\nthree\n');
  await t.commit('L2 Reword line two');
  await t.write('notes.txt', 'one\ntwo, lab\nthree\nfour\n');
  await t.commit('L3 Append four');
  await t.write('notes.txt', 'one\ntwo, lab\nthree\nfour, refined\n');
  await t.commit('L4 Refine four');
  await touch(t, 'L5 Add tests');
  await touch(t, 'L6 Add docs');
  await t.checkout('main');
  await t.write('notes.txt', 'one\ntwo, main\nthree\n');
  await t.commit('Main edits line two');
  await t.checkout('lab');
}

/** feature/a → b → c on main, with a merge of `side` into feature/b; main moved. HEAD: feature/c. */
export async function irebaseShape(t: TestRepo): Promise<void> {
  await t.write('notes.txt', 'one\n');
  await t.commit('Base');
  await t.branch('feature/a');
  await t.checkout('feature/a');
  await touch(t, 'A1 Add parser');
  await t.write('notes.txt', 'one\ntwo\n');
  await t.commit('A2 Edit notes');
  await touch(t, 'A3 Add tests');
  await t.branch('feature/b');
  await t.checkout('feature/b');
  const b1 = await touch(t, 'B1 Add lexer');
  await t.branch('side');
  await t.checkout('side');
  await t.write('side.txt', 'S1 Side work\n');
  const s1 = await t.commit('S1 Side work');
  await t.checkout('feature/b');
  await t.write('side.txt', 'S1 Side work\n');
  await t.commit('Merge side', undefined, { parents: [b1, s1] });
  await t.write('lexer.txt', 'lexer\n');
  await t.write('lexer_test.txt', 'lexer test\n');
  await t.commit('B2 Refine lexer');
  await t.branch('feature/c');
  await t.checkout('feature/c');
  await t.write('notes.txt', 'one\ntwo, revised\nthree\n');
  await t.commit('C1 Edit notes again');
  await touch(t, 'C2 Polish');
  await t.checkout('main');
  await t.write('main.txt', 'main\n');
  await t.commit('Main moves');
  await t.checkout('feature/c');
}

/** feature/a → b → c, one commit each, on main; main then moves. HEAD: feature/c. */
export async function stackShape(t: TestRepo): Promise<void> {
  await touch(t, 'Base');
  for (const b of ['feature/a', 'feature/b', 'feature/c']) {
    await t.branch(b);
    await t.checkout(b);
    await touch(t, `Work on ${b}`);
  }
  await t.checkout('main');
  await t.write('main.txt', 'main\n');
  await t.commit('Main moves');
  await t.checkout('feature/c');
}

/** `t.rev`, with git's `~n` and `^` suffixes. */
export const revOf = (t: TestRepo, spec: string): Promise<string> => revParse(t.repo, spec, t.dir);

/** First-parent subjects from `to` back to (not including) `from`, oldest first. */
export async function subjects(t: TestRepo, from: string, to: string): Promise<string[]> {
  const stop = await revOf(t, from);
  const out: string[] = [];
  for (let at: string | undefined = await revOf(t, to); at && at !== stop; ) {
    const c = await readCommit(t.repo, at);
    out.unshift(c.summary);
    at = c.parents[0];
  }
  return out;
}

/** `dev` (two commits by the visitor, `notes.txt` line two among them when `conflict`) pushed to origin
 *  (tracking ref, remote, upstream), main one commit ahead of its base. HEAD: dev. Returns dev's pushed tip. */
export async function pushedDev(t: TestRepo, conflict = false): Promise<string> {
  const me = { name: DEMO_IDENTITY.name, email: DEMO_IDENTITY.email };
  await t.write('notes.txt', 'one\ntwo\nthree\n');
  await t.commit('Base', me);
  await t.branch('dev');
  await t.checkout('dev');
  await t.write('d1.txt', 'd1\n');
  if (conflict) await t.write('notes.txt', 'one\ntwo, dev\nthree\n');
  await t.commit('D1 Add d1', me);
  await t.write('d2.txt', 'd2\n');
  const tip = await t.commit('D2 Add d2', me);
  const o = { fs: t.memfs, dir: t.dir };
  await git.writeRef({ ...o, ref: 'refs/remotes/origin/dev', value: tip });
  await git.setConfig({ ...o, path: 'remote.origin.url', value: '/demo/.origins/test.git' });
  await git.setConfig({ ...o, path: 'branch.dev.remote', value: 'origin' });
  await git.setConfig({ ...o, path: 'branch.dev.merge', value: 'refs/heads/dev' });
  await t.checkout('main');
  await t.write(conflict ? 'notes.txt' : 'm.txt', conflict ? 'one\ntwo, main\nthree\n' : 'm\n');
  await t.commit('Main moves on', me);
  await t.checkout('dev');
  return tip;
}
