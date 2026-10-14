import { describe, expect, it } from 'vitest';
import type { InProgress } from '../../../api/gen/InProgress';
import type { GraphPayload } from '../../../api/gen/GraphPayload';
import type { GraphRequest } from '../../gen/GraphRequest';
import { parseIndex } from '../read/indexFile';
import { makeTestRepo, setIndex } from '../read/testkit';
import { MODE_FILE } from '../read/trees';
import { midOperation } from '../write/inProgress';
import { inProgressName, readInProgress } from '../writeSeam';
import { clearSeq, mergedMessage, readSeq, SEQ_FILE, seqInProgress, seqOpName, writeSeq, type SeqState } from './state';

function state(over: Partial<SeqState>): SeqState {
  return {
    version: 1, kind: 'rebase', headName: 'refs/heads/lab', origHead: 'a'.repeat(40), onto: 'b'.repeat(40), target: 'main', interactive: true,
    todo: [{ op: 'pick', oid: 'c'.repeat(40), parent: null }], done: [{ op: 'pick', oid: 'd'.repeat(40), parent: null }], total: 2, head: 'b'.repeat(40),
    map: {}, range: [], refsAfter: {}, refsBefore: {}, deletes: {}, empty: 'drop', stop: null, picked: [], ...over,
  };
}

type Rebase = Extract<InProgress, { kind: 'rebase' }>;
const C = 'c'.repeat(40);
const D = 'd'.repeat(40);

describe('the sequencer state', () => {
  it('round-trips and clears', async () => {
    const t = await makeTestRepo();
    await t.commit('Base');
    const s = state({});
    await writeSeq(t.repo, t.repo.gitdir, s);
    expect(t.memfs.existsSync(`${t.repo.gitdir}/${SEQ_FILE}`)).toBe(true);
    expect(SEQ_FILE).toBe('gitvolt-demo-seq.json');
    expect(await readSeq(t.repo, t.repo.gitdir)).toEqual(s);
    await clearSeq(t.repo, t.repo.gitdir);
    expect(await readSeq(t.repo, t.repo.gitdir)).toBeNull();
    await clearSeq(t.repo, t.repo.gitdir);
  });

  it('refuses a state of another version', async () => {
    const t = await makeTestRepo();
    await t.commit('Base');
    t.memfs.writeFileSync(`${t.repo.gitdir}/${SEQ_FILE}`, JSON.stringify({ ...state({}), version: 2 }));
    await expect(readSeq(t.repo, t.repo.gitdir)).rejects.toMatchObject({ kind: 'Other' });
  });

  it('reads as a rebase stopped on a conflict, through readInProgress', async () => {
    const t = await makeTestRepo();
    await t.commit('Base');
    const stopped = { op: 'pick' as const, oid: C, parent: null };
    await writeSeq(t.repo, t.repo.gitdir, state({ stop: { reason: 'conflict', at: C, message: 'L2 Reword line two\n' }, todo: [], done: [{ op: 'pick', oid: D, parent: null }, stopped] }));
    const want = {
      kind: 'rebase', onto: 'b'.repeat(40), headName: 'refs/heads/lab', step: 2, total: 2, stoppedAt: C,
      editStop: null, editBase: null, editAdded: [], editChanged: false, editConflict: false, messageFailed: null, gitvolt: true, conflicted: 0, message: 'L2 Reword line two\n',
    };
    expect(seqInProgress(t.memfs, t.repo.gitdir)).toEqual(want);
    expect(readInProgress(t.memfs, t.repo.gitdir)).toEqual(want);
    expect(inProgressName(t.memfs, t.repo.gitdir)).toBe('rebase');
    expect(midOperation(t.memfs, t.repo.gitdir)).toBe(true);
  });

  it("ends a pick's conflict message with git's # Conflicts: block, and counts the conflicted paths", async () => {
    const t = await makeTestRepo();
    await t.write('b.txt', 'b\n');
    const head = await t.commit('Base');
    await setIndex(t, [
      ...[1, 2, 3].map((stage) => ({ path: 'b.txt', mode: MODE_FILE, oid: head, stage })),
      ...[2, 3].map((stage) => ({ path: 'z.txt', mode: MODE_FILE, oid: head, stage })),
    ]);
    const stop = { reason: 'conflict' as const, at: C, message: 'M multi\r\n', conflicts: ['b.txt', 'z.txt'] };
    await writeSeq(t.repo, t.repo.gitdir, state({ interactive: false, headName: null, stop, done: [{ op: 'pick', oid: C, parent: null }] }));
    const r = seqInProgress(t.memfs, t.repo.gitdir) as Rebase;
    expect([r.headName, r.gitvolt, r.step, r.conflicted, r.message]).toEqual(['detached HEAD', false, 1, 2, 'M multi\n\n# Conflicts:\n#\tb.txt\n#\tz.txt\n']);
    // A merge step's conflict has no such block (git's own message file).
    await writeSeq(t.repo, t.repo.gitdir, state({ stop: { ...stop, message: 'Merge side\n' }, done: [{ op: 'merge', oid: C, parents: [D] }] }));
    expect((seqInProgress(t.memfs, t.repo.gitdir) as Rebase).message).toBe('Merge side\n');
    // A message without its final newline gets git's newline and no blank line.
    await writeSeq(t.repo, t.repo.gitdir, state({ stop: { ...stop, message: 'Subject\n\nbody' } }));
    expect((seqInProgress(t.memfs, t.repo.gitdir) as Rebase).message).toBe('Subject\n\nbody\n# Conflicts:\n#\tb.txt\n#\tz.txt\n');
  });

  it("counts the steps done as git's msgnum, running or stopped", async () => {
    const t = await makeTestRepo();
    await t.commit('Base');
    await writeSeq(t.repo, t.repo.gitdir, state({ done: [{ op: 'pick', oid: D, parent: null }, { op: 'updateRef', ref: 'refs/heads/side' }], total: 4 }));
    const r = seqInProgress(t.memfs, t.repo.gitdir) as Rebase;
    expect([r.step, r.total, r.stoppedAt, r.message]).toEqual([2, 4, null, '']);
  });

  it('reads a conflict at an Edit row as the Edit\'s own stop', async () => {
    const t = await makeTestRepo();
    await t.commit('Base');
    await writeSeq(t.repo, t.repo.gitdir, state({ stop: { reason: 'conflict', at: C, message: 'E\n' }, done: [{ op: 'pick', oid: C, parent: null, edit: true }] }));
    const r = seqInProgress(t.memfs, t.repo.gitdir) as Rebase;
    expect([r.editStop, r.editConflict]).toEqual([null, true]);
  });

  it('reads an Edit stop, about to commit: the made commit, its parent, its added paths, the message', async () => {
    const t = await makeTestRepo();
    await t.write('a.txt', 'a\n');
    await t.write('b.txt', 'b\n');
    const made = await t.commit('Edited');
    const files = await t.memfs.promises.readFile(`${t.repo.gitdir}/index`);
    const madeFiles = parseIndex(files as Uint8Array).map((e): [string, string, number] => [e.path, e.oid, e.mode]);
    const stop = { reason: 'edit' as const, at: C, message: 'Edited\r\n\r\n', made, editBase: D, added: ['b.txt'], madeFiles };
    await writeSeq(t.repo, t.repo.gitdir, state({ stop, done: [{ op: 'pick', oid: C, parent: null, edit: true }] }));
    const r = seqInProgress(t.memfs, t.repo.gitdir) as Rebase;
    expect([r.editStop, r.editBase, r.editAdded, r.editChanged, r.editConflict, r.stoppedAt, r.message]).toEqual([made, D, ['b.txt'], false, false, C, 'Edited\n']);
    // A change staged since, or a conflict stage, is a changed index.
    await setIndex(t, [{ path: 'a.txt', mode: MODE_FILE, oid: made, stage: 0 }, { path: 'b.txt', mode: MODE_FILE, oid: madeFiles[1][1], stage: 0 }]);
    expect((seqInProgress(t.memfs, t.repo.gitdir) as Rebase).editChanged).toBe(true);
    await setIndex(t, [{ path: 'a.txt', mode: MODE_FILE, oid: madeFiles[0][1], stage: 0 }]);
    expect((seqInProgress(t.memfs, t.repo.gitdir) as Rebase).editChanged).toBe(true);
    await setIndex(t, [{ path: 'a.txt', mode: MODE_FILE, oid: madeFiles[0][1], stage: 0 }, { path: 'b.txt', mode: MODE_FILE, oid: madeFiles[1][1], stage: 2 }]);
    expect((seqInProgress(t.memfs, t.repo.gitdir) as Rebase).editChanged).toBe(true);
  });

  it("reads a conflict at a fold as git's: HEAD is the commit being amended, and its message shows", async () => {
    const seen: GraphRequest[] = [];
    const g = await makeTestRepo('graphs', () => ({ addCommits: (c) => c.length, build: (r) => (seen.push(r), {} as GraphPayload), walkOrder: () => [] }));
    await g.write('a.txt', 'a\n');
    const head = await g.commit('A first\r\n\r\nA body');
    const fold = state({ head, stop: { reason: 'conflict', at: C, message: 'A first\n\nB second\n', conflicts: ['c.txt'] }, done: [{ op: 'pick', oid: D, parent: null }, { op: 'fold', oid: C, fixup: false, message: 'A first\n\nB second\n' }] });
    await writeSeq(g.repo, g.repo.gitdir, fold);
    const r = readInProgress(g.memfs, g.repo.gitdir, 'A first\r\n\r\nA body\n') as Rebase;
    expect([r.editStop, r.editBase, r.editChanged, r.editConflict, r.message]).toEqual([head, null, false, false, 'A first\n\nA body\n']);
    // The graph reads HEAD's message for it.
    await g.repo.demo!.graph({ limit: null });
    expect((seen[0].inProgress[g.dir] as Rebase).message.startsWith('A first\n\nA body')).toBe(true);
  });

  it('reads as a cherry-pick with its head and message', async () => {
    const t = await makeTestRepo();
    await t.commit('Base');
    await writeSeq(t.repo, t.repo.gitdir, state({ kind: 'cherryPick', headName: 'refs/heads/main', interactive: false, stop: { reason: 'conflict', at: 'e'.repeat(40), message: 'Fix\n' } }));
    expect(seqInProgress(t.memfs, t.repo.gitdir)).toEqual({ kind: 'cherryPick', head: 'e'.repeat(40), message: 'Fix\n', conflicted: 0 });
    expect(inProgressName(t.memfs, t.repo.gitdir)).toBe('cherry-pick');
  });

  it("reads a revert's conflict with git's block, an empty pick's stop without one", async () => {
    const t = await makeTestRepo();
    await t.commit('Base');
    const message = 'Revert "main"\n\nThis reverts commit ' + 'e'.repeat(40) + '.\n';
    await writeSeq(t.repo, t.repo.gitdir, state({ kind: 'revert', interactive: false, stop: { reason: 'conflict', at: 'e'.repeat(40), message, conflicts: ['c.txt'] } }));
    expect(seqInProgress(t.memfs, t.repo.gitdir)).toEqual({ kind: 'revert', head: 'e'.repeat(40), message: `${message}\n# Conflicts:\n#\tc.txt\n`, conflicted: 0 });
    expect(seqOpName(t.memfs, t.repo.gitdir)).toBe('revert');
    await writeSeq(t.repo, t.repo.gitdir, state({ kind: 'cherryPick', interactive: false, stop: { reason: 'empty', at: C, message: 'S same\n', error: 'empty' } }));
    expect(seqInProgress(t.memfs, t.repo.gitdir)).toEqual({ kind: 'cherryPick', head: C, message: 'S same\n', conflicted: 0 });
  });

  it("is no operation while a pick or revert runs without a stop (git's sequencer alone isn't one)", async () => {
    const t = await makeTestRepo();
    await t.commit('Base');
    for (const kind of ['cherryPick', 'revert'] as const) {
      await writeSeq(t.repo, t.repo.gitdir, state({ kind, interactive: false }));
      expect([seqInProgress(t.memfs, t.repo.gitdir), seqOpName(t.memfs, t.repo.gitdir), readInProgress(t.memfs, t.repo.gitdir), inProgressName(t.memfs, t.repo.gitdir), midOperation(t.memfs, t.repo.gitdir)]).toEqual([null, null, null, null, false]);
    }
  });

  it('merges messages as the editor does', () => {
    expect(mergedMessage(['A\r\n\r\nbody\n', '', 'B  \n'])).toBe('A\n\nbody\n\nB\n');
    // The core's: only CRLF becomes LF, and Rust's whitespace is trimmed (NEL is, BOM isn't).
    expect(mergedMessage(['A\rx\r', 'B\u0085', 'C\ufeff'])).toBe('A\rx\n\nB\n\nC\ufeff\n');
    expect(mergedMessage([' \n', ''])).toBe('\n');
  });
});
