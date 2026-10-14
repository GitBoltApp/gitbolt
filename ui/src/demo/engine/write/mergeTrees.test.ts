import { describe, expect, it } from 'vitest';
import { utf8Bytes } from '../read/bytes';
import { makeTestRepo, type TestRepo } from '../read/testkit';
import { MODE_EXEC, MODE_FILE, MODE_GITLINK, MODE_LINK, readBlobBytes } from '../read/trees';
import { mergeTrees, type WorktreeWrite } from './mergeTrees';
import { writeBlobBytes, writeTreeOf } from './objects';

type Spec = Record<string, string | { exec: string } | { link: string } | { bin: string } | { sub: string }>;

async function tree(t: TestRepo, files: Spec): Promise<string> {
  const out: { path: string; mode: number; oid: string }[] = [];
  for (const [path, v] of Object.entries(files)) {
    if (typeof v !== 'string' && 'sub' in v) {
      out.push({ path, mode: MODE_GITLINK, oid: v.sub });
      continue;
    }
    const [mode, bytes] =
      typeof v === 'string' ? [MODE_FILE, utf8Bytes(v)] : 'exec' in v ? [MODE_EXEC, utf8Bytes(v.exec)] : 'link' in v ? [MODE_LINK, utf8Bytes(v.link)] : [MODE_FILE, Uint8Array.from([0, ...utf8Bytes(v.bin)])];
    out.push({ path, mode, oid: await writeBlobBytes(t.repo, bytes) });
  }
  return writeTreeOf(t.repo, out);
}

const lines = (name: string, change: Record<number, string> = {}) => Array.from({ length: 8 }, (_, i) => `${change[i + 1] ?? `${name} line ${i + 1}`}\n`).join('');
const text = (w: WorktreeWrite | undefined) => (w && 'bytes' in w ? new TextDecoder().decode(w.bytes) : w);
const L = { ours: 'HEAD', theirs: 'side' };

async function merge(base: Spec, ours: Spec, theirs: Spec, labels = L) {
  const t = await makeTestRepo();
  const m = await mergeTrees(t.repo, await tree(t, base), await tree(t, ours), await tree(t, theirs), labels);
  return { t, m, stages: (p: string) => m.entries.filter((e) => e.path === p).map((e) => e.stage) };
}

describe('mergeTrees', () => {
  it('merges changes to different files and to different lines of one file', async () => {
    const { m } = await merge({ 'a.txt': lines('a'), 'b.txt': lines('b'), 'c.sh': 'run\n' }, { 'a.txt': lines('a', { 1: 'ours' }), 'b.txt': lines('b'), 'c.sh': { exec: 'run\n' } }, { 'a.txt': lines('a', { 8: 'theirs' }), 'b.txt': lines('b', { 2: 'theirs' }), 'c.sh': 'run, theirs\n' });
    expect([m.conflicts, m.entries.every((e) => e.stage === 0), m.touched]).toEqual([[], true, ['a.txt', 'b.txt', 'c.sh']]);
    expect(m.entries.find((e) => e.path === 'c.sh')?.mode).toBe(MODE_EXEC);
    expect(m.worktree.get('a.txt')).toMatchObject({ mode: MODE_FILE, oid: expect.stringMatching(/^[0-9a-f]{40}$/) });
  });

  it('conflicts on the same line with stages 1–3 and markers in the file', async () => {
    const { m, stages } = await merge({ 'a.txt': '1\n2\n3\n' }, { 'a.txt': '1\nO\n3\n' }, { 'a.txt': '1\nT\n3\n' });
    expect([m.conflicts, stages('a.txt'), text(m.worktree.get('a.txt'))]).toEqual([['a.txt'], [1, 2, 3], '1\n<<<<<<< HEAD\nO\n=======\nT\n>>>>>>> side\n3\n']);
  });

  it('modify/delete keeps the modified file with stages 1 and 2 or 3', async () => {
    const { m, stages } = await merge({ 'mine.txt': lines('m'), 'theirs.txt': lines('t') }, { 'mine.txt': lines('m', { 1: 'ours' }) }, { 'theirs.txt': lines('t', { 1: 'theirs' }) });
    expect([m.conflicts, stages('mine.txt'), stages('theirs.txt'), m.worktree.has('mine.txt')]).toEqual([['mine.txt', 'theirs.txt'], [1, 2], [1, 3], false]);
    expect(m.worktree.get('theirs.txt')).toMatchObject({ mode: MODE_FILE });
  });

  it('merges an edit into a renamed file, and conflicts a rename against a delete at the new path', async () => {
    const { m, stages } = await merge(
      { 'ren.txt': lines('r'), 'gone.txt': lines('g') },
      { 'ren-ours.txt': lines('r', { 2: 'ours' }) },
      { 'ren.txt': lines('r', { 7: 'theirs' }), 'gone-theirs.txt': lines('g') },
    );
    expect([m.conflicts, stages('ren-ours.txt'), stages('gone-theirs.txt')]).toEqual([['gone-theirs.txt'], [0], [1, 3]]);
    expect(m.worktree.get('ren-ours.txt')).toMatchObject({ mode: MODE_FILE });
  });

  it('labels a conflicted rename with each side\'s path', async () => {
    const { m } = await merge({ 'r.txt': lines('r') }, { 'r2.txt': lines('r', { 4: 'main' }) }, { 'r.txt': lines('r', { 4: 'side' }) });
    expect(text(m.worktree.get('r2.txt'))).toContain('<<<<<<< HEAD:r2.txt\nmain\n=======\nside\n>>>>>>> side:r.txt\n');
  });

  // Expected shapes below are git 2.53's (`git merge-tree --write-tree`) for the same trees.
  it('a file where the result has a folder moves aside to path~label, the folder keeping the path', async () => {
    const r1 = await merge({ d: lines('d'), k: 'k\n' }, { d: lines('d', { 1: 'O' }), k: 'k\n' }, { 'd/x': 'x\n', k: 'k\n' });
    expect([r1.m.conflicts, r1.stages('d~HEAD'), r1.stages('d/x'), r1.stages('d')]).toEqual([['d~HEAD'], [1, 2], [0], []]);
    expect([...r1.m.worktree.keys()]).toEqual(['d', 'd/x', 'd~HEAD']);
    expect([r1.m.worktree.get('d'), r1.m.worktree.get('d~HEAD')]).toEqual([null, { mode: MODE_FILE, oid: r1.m.entries.find((e) => e.path === 'd~HEAD' && e.stage === 2)?.oid }]);
    const r12 = await merge({ 'd/x': lines('x'), k: 'k\n' }, { 'd/x': lines('x', { 1: 'O' }), k: 'k\n', 'd~feature_x': 'taken\n' }, { d: 'f\n', k: 'k\n' }, { ours: 'HEAD', theirs: 'feature/x' });
    expect([r12.m.conflicts, r12.stages('d/x'), r12.stages('d~feature_x_0'), r12.stages('d')]).toEqual([['d/x', 'd~feature_x_0'], [1, 2], [3], []]);
    expect([r12.m.worktree.has('d/x'), r12.m.worktree.get('d~feature_x_0')]).toEqual([false, { mode: MODE_FILE, oid: r12.m.entries.find((e) => e.path === 'd~feature_x_0')?.oid }]);
  });

  it('a file arriving where ours has its own merges with it as two additions', async () => {
    const r3 = await merge({ 'r.txt': lines('r'), k: 'k\n' }, { 'q.txt': 'unrelated\n', k: 'k\n' }, { 'q.txt': lines('r', { 1: 'T' }), k: 'k\n' });
    expect([r3.m.conflicts, r3.stages('q.txt'), text(r3.m.worktree.get('q.txt'))]).toEqual([['q.txt'], [2, 3], `<<<<<<< HEAD\nunrelated\n=======\n${lines('r', { 1: 'T' })}>>>>>>> side\n`]);
    const r4 = await merge({ 'r.txt': lines('r'), k: 'k\n' }, { 'ro.txt': lines('r'), 'rt.txt': 'mine\n', k: 'k\n' }, { 'rt.txt': lines('r'), k: 'k\n' });
    expect([r4.m.conflicts, r4.stages('r.txt'), r4.stages('ro.txt'), r4.stages('rt.txt')]).toEqual([['r.txt', 'ro.txt', 'rt.txt'], [1], [2], [2, 3]]);
    expect(text(r4.m.worktree.get('rt.txt'))).toBe(`<<<<<<< HEAD\nmine\n=======\n${lines('r')}>>>>>>> side\n`);
  });

  it('a file renamed to two names: the base at its old path, the merged content at both names', async () => {
    const clean = await merge({ 'r.txt': lines('r'), k: 'k\n' }, { 'ro.txt': lines('r', { 1: 'O' }), k: 'k\n' }, { 'rt.txt': lines('r', { 8: 'T' }), k: 'k\n' });
    const oid = (p: string) => clean.m.entries.find((e) => e.path === p && e.stage > 0)?.oid;
    expect([clean.m.conflicts, clean.stages('r.txt'), clean.stages('ro.txt'), clean.stages('rt.txt'), oid('ro.txt') === oid('rt.txt'), clean.m.worktree.has('r.txt')]).toEqual([['r.txt', 'ro.txt', 'rt.txt'], [1], [2], [3], true, false]);
    const conflicted = await merge({ 'r.txt': lines('r'), k: 'k\n' }, { 'ro.txt': lines('r', { 4: 'O' }), k: 'k\n' }, { 'rt.txt': lines('r', { 4: 'T' }), k: 'k\n' });
    const blob = conflicted.m.entries.find((e) => e.path === 'rt.txt')!.oid;
    expect(new TextDecoder().decode(await readBlobBytes(conflicted.t.repo, blob))).toContain('<<<<<<<< HEAD:ro.txt\nO\n========\nT\n>>>>>>>> side:rt.txt\n');
  });

  it("theirs' file arriving at ours' name of a rename/rename merges with it as two additions, whichever path comes first", async () => {
    const added = `<<<<<<< HEAD\n${lines('b')}=======\n${lines('a')}>>>>>>> side\n`;
    for (const moved of ['a.txt', 'z.txt']) {
      const { t, m, stages } = await merge({ [moved]: lines('a'), 'b.txt': lines('b'), k: 'k\n' }, { [moved]: lines('a'), 'ro.txt': lines('b'), k: 'k\n' }, { 'ro.txt': lines('a'), 'rt.txt': lines('b'), k: 'k\n' });
      const blob = async (stage: number) => new TextDecoder().decode(await readBlobBytes(t.repo, m.entries.find((e) => e.path === 'ro.txt' && e.stage === stage)!.oid));
      expect([m.conflicts, stages('b.txt'), stages('ro.txt'), stages('rt.txt'), await blob(2), await blob(3), text(m.worktree.get('ro.txt'))]).toEqual([['b.txt', 'ro.txt', 'rt.txt'], [1], [2, 3], [3], lines('b'), lines('a'), added]);
    }
  });

  it('a regular file against a symlink moves aside; the symlink keeps the path', async () => {
    const r10 = await merge({ l: 'f\n' }, { l: 'f2\n' }, { l: { link: 't' } });
    expect([r10.m.conflicts, r10.stages('l'), r10.stages('l~HEAD')]).toEqual([['l', 'l~HEAD'], [3], [1, 2]]);
    expect([r10.m.worktree.get('l')?.mode, r10.m.worktree.get('l~HEAD')?.mode]).toEqual([MODE_LINK, MODE_FILE]);
    const back = await merge({ l: 'f\n' }, { l: { link: 'o' } }, { l: 'f2\n' });
    expect([back.m.conflicts, back.stages('l'), back.stages('l~side'), back.m.worktree.has('l')]).toEqual([['l', 'l~side'], [2], [1, 3], false]);
  });

  it('a base of a kind neither side has leaves no base stage', async () => {
    const sub = { sub: '1111111111111111111111111111111111111111' };
    const n8 = await merge({ s: sub, k: 'k\n' }, { s: { link: 'o' }, k: 'k\n' }, { s: 'f\n', k: 'k\n' });
    const n9 = await merge({ s: { link: 'b' }, k: 'k\n' }, { s: sub, k: 'k\n' }, { s: 'f\n', k: 'k\n' });
    const n10 = await merge({ s: sub, k: 'k\n' }, { s: 'f\n', k: 'k\n' }, { s: { link: 't' }, k: 'k\n' });
    expect([n8.m.conflicts, n8.stages('s'), n8.stages('s~side')]).toEqual([['s', 's~side'], [2], [3]]);
    expect([n9.m.conflicts, n9.stages('s'), n9.stages('s~side')]).toEqual([['s', 's~side'], [2], [3]]);
    expect([n10.m.conflicts, n10.stages('s'), n10.stages('s~HEAD')]).toEqual([['s', 's~HEAD'], [3], [2]]);
  });

  it('add/add merges two texts from nothing; binary files and symlinks keep ours', async () => {
    const { m, stages } = await merge({ keep: 'k\n' }, { keep: 'k\n', 'new.txt': 'ours\n', 'same.txt': 'x\n', 'b.dat': { bin: 'o' }, link: { link: 'o' } }, { keep: 'k\n', 'new.txt': 'theirs\n', 'same.txt': 'x\n', 'b.dat': { bin: 't' }, link: { link: 't' } });
    expect([m.conflicts, stages('new.txt'), stages('same.txt'), text(m.worktree.get('new.txt'))]).toEqual([['b.dat', 'link', 'new.txt'], [2, 3], [0], '<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> side\n']);
    expect([m.worktree.has('b.dat'), m.worktree.has('link')]).toEqual([false, false]);
  });

  it('sizes a renamed file\'s conflict markers from the attribute of the path git reads (verified against git merge)', async () => {
    const size = async (p: string) => ({ 'a.txt': 5, 'b.txt': 9, 'c.txt': 6 })[p] ?? 7;
    const run = async (ours: Spec, theirs: Spec) => {
      const t = await makeTestRepo();
      const m = await mergeTrees(t.repo, await tree(t, { 'a.txt': lines('a') }), await tree(t, ours), await tree(t, theirs), L, size);
      const out: (number | undefined)[] = [];
      for (const w of [...m.worktree.values()].filter((x) => x !== null)) {
        const body = 'bytes' in w ? text(w) : new TextDecoder().decode(await readBlobBytes(t.repo, w.oid));
        out.push(String(body).match(/^<+/m)?.[0].length);
      }
      return out;
    };
    // Two names: the base path's size, plus one.
    expect(await run({ 'c.txt': lines('a', { 4: 'ours' }) }, { 'b.txt': lines('a', { 4: 'theirs' }) })).toContain(6);
    // Ours renamed, theirs edited: the new name's.
    expect(await run({ 'c.txt': lines('a', { 4: 'ours' }) }, { 'a.txt': lines('a', { 4: 'theirs' }) })).toEqual([6]);
    // Theirs renamed, ours edited: the new name's.
    expect(await run({ 'a.txt': lines('a', { 4: 'ours' }) }, { 'b.txt': lines('a', { 4: 'theirs' }) })).toEqual([9]);
  });
});
