import { describe, expect, it } from 'vitest';
import { blobId } from '../engine/read/bytes';
import { fakeCtx, makeTestRepo, setIndex } from '../engine/read/testkit';
import { loadIndex } from '../engine/write/index';
import { mainWt } from '../engine/write/seam';
import { RESOLVE_ENDED } from '../engine/write/staging';
import { commitHandlers } from './commit';
import { conflictHandlers } from './conflicts';
import { journalHandlers } from './journal';
import { mergeHandlers } from './merge';

const NO = { head: null, refs: {} };

/** main and feature change a.txt's line 2; feature deletes gone.txt, which main changes. Merged: stopped. */
async function conflicted(branch = 'feature', attrs = '') {
  const t = await makeTestRepo();
  if (attrs) await t.write('.gitattributes', attrs);
  await t.write('a.txt', '1\n2\n3\n');
  await t.write('gone.txt', Array.from({ length: 8 }, (_, i) => `g${i}\n`).join(''));
  const base = await t.commit('Base');
  await t.branch(branch, base);
  await t.checkout(branch);
  await t.write('a.txt', '1\nF\n3\n');
  await t.remove('gone.txt');
  await t.commit('Feature');
  await t.checkout('main');
  await t.write('a.txt', '1\nM\n3\n');
  await t.write('gone.txt', Array.from({ length: 8 }, (_, i) => `g${i}${i === 0 ? ' main' : ''}\n`).join(''));
  await t.commit('Main');
  const ctx = fakeCtx(t.repo);
  await mergeHandlers.integrate({ repo: 1, worktree: t.dir, kind: 'merge', target: branch, expect: NO, confirm: { autostash: false } }, ctx);
  return { t, ctx };
}

const hash = async (t: Awaited<ReturnType<typeof conflicted>>['t'], p: string) => blobId(t.memfs.readFileSync(`${t.dir}/${p}`) as Uint8Array);
const resolve = (ctx: ReturnType<typeof fakeCtx>, dir: string, path: string, resolution: Parameters<typeof conflictHandlers.resolveFile>[0]['resolution'], o: { base?: string; confirmMarkers?: boolean; confirmDiscard?: boolean } = {}) =>
  conflictHandlers.resolveFile({ repo: 1, worktree: dir, path, resolution, ...o }, ctx);

describe('conflictFile', () => {
  it('gives a text conflict its segments, labels and full panes with mapped regions', async () => {
    const { t, ctx } = await conflicted();
    const f = await conflictHandlers.conflictFile({ repo: 1, worktree: t.dir, path: 'a.txt' }, ctx);
    expect(f).toEqual({
      path: 'a.txt',
      kind: 'bothModified',
      text: true,
      segments: [{ kind: 'common', text: '1\n' }, { kind: 'conflict', id: 0, base: ['2\n'], current: ['M\n'], incoming: ['F\n'] }, { kind: 'common', text: '3\n' }],
      current: { text: '1\nM\n3\n', regions: [{ id: 0, start: 2, lines: 1 }] },
      incoming: { text: '1\nF\n3\n', regions: [{ id: 0, start: 2, lines: 1 }] },
      labels: { current: 'main', incoming: 'feature' },
      encoding: 'UTF-8',
      eol: 'lf',
      base: await hash(t, 'a.txt'),
    });
  });

  it('gives a one-sided conflict no panes, and a path without a conflict nothing', async () => {
    const { t, ctx } = await conflicted();
    const f = await conflictHandlers.conflictFile({ repo: 1, worktree: t.dir, path: 'gone.txt' }, ctx);
    expect([f?.kind, f?.text, f?.segments, f?.current, f?.incoming]).toEqual(['deletedByThem', false, [], null, null]);
    expect(await conflictHandlers.conflictFile({ repo: 1, worktree: t.dir, path: 'nope.txt' }, ctx)).toBeNull();
  });
});

describe('resolveFile', () => {
  it('saves the merge tool text over the hashed file and stages it, as a staging step', async () => {
    const { t, ctx } = await conflicted();
    await expect(resolve(ctx, t.dir, 'a.txt', { kind: 'text', text: 'x\n' }, { base: 'f'.repeat(40) })).rejects.toMatchObject({ kind: 'Stale', message: 'a.txt changed on disk' });
    const r = await resolve(ctx, t.dir, 'a.txt', { kind: 'text', text: '1\nM and F\n3\n' }, { base: await hash(t, 'a.txt') });
    expect([r.outcome, t.memfs.readFileSync(`${t.dir}/a.txt`, 'utf8'), (await loadIndex(mainWt(t.repo))).filter((e) => e.path === 'a.txt').map((e) => e.stage), r.staging.undo]).toEqual([null, '1\nM and F\n3\n', [0], 'resolve a.txt']);
    await expect(resolve(ctx, t.dir, 'a.txt', { kind: 'current' })).rejects.toMatchObject({ kind: 'Stale', message: "a.txt isn't conflicted anymore" });
  });

  it('asks before taking a side over hand edits, and not when the file is as git left it', async () => {
    const { t, ctx } = await conflicted();
    const left = t.memfs.readFileSync(`${t.dir}/a.txt`, 'utf8') as string;
    await t.write('a.txt', `${left}my edit\n`);
    await expect(resolve(ctx, t.dir, 'a.txt', { kind: 'incoming' })).rejects.toMatchObject({ kind: 'Conflict', message: 'Discard your edits to a.txt?', detail: { kind: 'discardEdits', path: 'a.txt' } });
    await t.write('a.txt', left);
    const r = await resolve(ctx, t.dir, 'a.txt', { kind: 'incoming' });
    expect([t.memfs.readFileSync(`${t.dir}/a.txt`, 'utf8'), r.staging.undo]).toEqual(['1\nF\n3\n', 'resolve a.txt with incoming']);
  });

  it('marks a file resolved as it is only once asked about markers, and takes the deleting side by removing it', async () => {
    const { t, ctx } = await conflicted();
    await expect(resolve(ctx, t.dir, 'a.txt', { kind: 'asIs' })).rejects.toMatchObject({ kind: 'Conflict', message: 'a.txt still has conflict markers', detail: { kind: 'markersRemain', path: 'a.txt' } });
    await resolve(ctx, t.dir, 'a.txt', { kind: 'asIs' }, { confirmMarkers: true });
    await resolve(ctx, t.dir, 'gone.txt', { kind: 'incoming' });
    expect([t.memfs.existsSync(`${t.dir}/gone.txt`), (await loadIndex(mainWt(t.repo))).map((e) => [e.path, e.stage])]).toEqual([false, [['a.txt', 0]]]);
    const done = await commitHandlers.commit({ repo: 1, worktree: t.dir, summary: "Merge branch 'feature'", description: '', amend: false, stageAll: false, expect: NO }, ctx);
    expect(done.journal.undo?.label).toBe('merge feature into main');
  });
});

/** One file `name` at base, feature and main (in that order of commits); merged: stopped. */
async function mergedFile(name: string, base: string | Uint8Array | null, theirs: string | Uint8Array, ours: string | Uint8Array) {
  const t = await makeTestRepo();
  await t.write('keep.txt', 'k\n');
  if (base !== null) await t.write(name, base);
  const b = await t.commit('Base');
  await t.branch('feature', b);
  await t.checkout('feature');
  await t.write(name, theirs);
  await t.commit('Feature');
  await t.checkout('main');
  await t.write(name, ours);
  await t.commit('Main');
  const ctx = fakeCtx(t.repo);
  await mergeHandlers.integrate({ repo: 1, worktree: t.dir, kind: 'merge', target: 'feature', expect: NO, confirm: { autostash: false } }, ctx);
  return { t, ctx };
}

describe('conflictFile, as the core reads git merge-file --diff3', () => {
  it('keeps CRLF and a last line without a newline in the region lines', async () => {
    const { t, ctx } = await mergedFile('w.txt', 'top\r\nmid\r\nend\r\nlast base', 'top\r\nTHEIRS\r\nend\r\nlast theirs', 'top\r\nOURS\r\nend\r\nlast ours');
    const f = await conflictHandlers.conflictFile({ repo: 1, worktree: t.dir, path: 'w.txt' }, ctx);
    const conflicts = f?.segments.filter((s) => s.kind === 'conflict');
    expect(conflicts?.map((c) => [c.current, c.incoming])).toEqual([
      [['OURS\r\n'], ['THEIRS\r\n']],
      [['last ours'], ['last theirs']],
    ]);
    expect([f?.current?.regions, f?.eol]).toEqual([
      [
        { id: 0, start: 2, lines: 1 },
        { id: 1, start: 4, lines: 1 },
      ],
      'crlf',
    ]);
    // A text resolution in a CRLF file: the tool's LF lines are saved as CRLF.
    await resolve(ctx, t.dir, 'w.txt', { kind: 'text', text: 'one\ntwo\n' }, { base: f!.base! });
    expect(t.memfs.readFileSync(`${t.dir}/w.txt`, 'utf8')).toBe('one\r\ntwo\r\n');
  });

  it('gives add/add an empty base and no trailing common text, and a binary conflict no text', async () => {
    const { t, ctx } = await mergedFile('n.txt', null, 'theirs\n', 'ours\n');
    const f = await conflictHandlers.conflictFile({ repo: 1, worktree: t.dir, path: 'n.txt' }, ctx);
    expect([f?.kind, f?.segments, f?.current?.regions]).toEqual(['bothAdded', [{ kind: 'conflict', id: 0, base: [], current: ['ours\n'], incoming: ['theirs\n'] }], [{ id: 0, start: 1, lines: 1 }]]);
    const bin = await mergedFile('logo.bin', Uint8Array.of(0, 1), Uint8Array.of(0, 7, 7, 7, 0, 9), Uint8Array.of(0, 2));
    const g = await conflictHandlers.conflictFile({ repo: 1, worktree: bin.t.dir, path: 'logo.bin' }, bin.ctx);
    expect([g?.kind, g?.text, g?.current, g?.encoding, g?.eol]).toEqual(['bothModified', false, null, 'UTF-8', 'lf']);
    // git left ours there: taking theirs throws nothing away.
    await resolve(bin.ctx, bin.t.dir, 'logo.bin', { kind: 'incoming' });
    expect([...(bin.t.memfs.readFileSync(`${bin.t.dir}/logo.bin`) as Uint8Array)]).toEqual([0, 7, 7, 7, 0, 9]);
  });

  it("answers a submodule's conflict without text, and resolves it in the index alone", async () => {
    const t = await makeTestRepo();
    await t.write('a.txt', 'a\n');
    await t.commit('Base');
    const [b, c, i] = ['1', '2', '3'].map((x) => x.repeat(40));
    await setIndex(t, [
      { path: 'a.txt', mode: 0o100644, oid: (await loadIndex(mainWt(t.repo)))[0].oid, stage: 0 },
      ...[b, c, i].map((oid, n) => ({ path: 'mod', mode: 0o160000, oid, stage: n + 1 })),
      ...[b, c].map((oid, n) => ({ path: 'sub', mode: 0o160000, oid, stage: n + 1 })),
    ]);
    t.memfs.mkdirpSync(`${t.dir}/sub`);
    const ctx = fakeCtx(t.repo);
    const f = await conflictHandlers.conflictFile({ repo: 1, worktree: t.dir, path: 'mod' }, ctx);
    expect([f?.kind, f?.text, f?.labels, f?.base]).toEqual(['bothModified', false, { current: 'Current', incoming: 'Incoming' }, null]);
    const r = await resolve(ctx, t.dir, 'mod', { kind: 'current' });
    await resolve(ctx, t.dir, 'sub', { kind: 'delete' });
    expect([r.outcome, (await loadIndex(mainWt(t.repo))).map((e) => [e.path, e.stage, e.oid.slice(0, 1)]), t.memfs.existsSync(`${t.dir}/sub`)]).toEqual([
      null,
      [
        ['a.txt', 0, expect.any(String)],
        ['mod', 0, '2'],
      ],
      true,
    ]);
  });
});

describe('resolveFile, refusals and staging steps', () => {
  it('never removes a repository standing at the path', async () => {
    const { t, ctx } = await conflicted();
    await t.remove('gone.txt');
    t.memfs.mkdirpSync(`${t.dir}/gone.txt/inner/.git`);
    for (const kind of ['current', 'delete'] as const) {
      await expect(resolve(ctx, t.dir, 'gone.txt', { kind }, { confirmDiscard: true })).rejects.toMatchObject({ kind: 'InvalidInput', message: 'gone.txt is a repository in the way: move it first' });
    }
    expect(t.memfs.existsSync(`${t.dir}/gone.txt/inner/.git`)).toBe(true);
  });

  it('knows a file git left in diff3 style, its labels in UTF-8, from a hand edit', async () => {
    const { t, ctx } = await conflicted();
    // As `git -c merge.conflictStyle=diff3 merge fé` leaves it.
    await t.write('a.txt', '1\n<<<<<<< HEAD\nM\n||||||| a810de5\n2\n=======\nF\n>>>>>>> fé\n3\n');
    await resolve(ctx, t.dir, 'a.txt', { kind: 'current' });
    expect(t.memfs.readFileSync(`${t.dir}/a.txt`, 'utf8')).toBe('1\nM\n3\n');
    // The demo's own merge writes that label as git does.
    const own = await conflicted('fé');
    expect(own.t.memfs.readFileSync(`${own.t.dir}/a.txt`, 'utf8')).toContain('>>>>>>> fé\n');
    await resolve(own.ctx, own.t.dir, 'a.txt', { kind: 'current' });
  });

  it('undoes and redoes a resolution as a staging step, and refuses once the file changed', async () => {
    const { t, ctx } = await conflicted();
    const left = t.memfs.readFileSync(`${t.dir}/a.txt`, 'utf8');
    const stages = async () => (await loadIndex(mainWt(t.repo))).filter((e) => e.path === 'a.txt').map((e) => e.stage);
    await resolve(ctx, t.dir, 'a.txt', { kind: 'incoming' });
    const undone = await journalHandlers.stagingUndo({ repo: 1, worktree: t.dir }, ctx);
    expect([await stages(), t.memfs.readFileSync(`${t.dir}/a.txt`, 'utf8'), undone.staging]).toEqual([[1, 2, 3], left, { undo: null, redo: 'resolve a.txt with incoming', off: null }]);
    const redone = await journalHandlers.stagingRedo({ repo: 1, worktree: t.dir }, ctx);
    expect([await stages(), t.memfs.readFileSync(`${t.dir}/a.txt`, 'utf8'), redone.staging.undo]).toEqual([[0], '1\nF\n3\n', 'resolve a.txt with incoming']);
    await journalHandlers.stagingUndo({ repo: 1, worktree: t.dir }, ctx);
    await t.write('a.txt', 'edited\n');
    await expect(journalHandlers.stagingRedo({ repo: 1, worktree: t.dir }, ctx)).rejects.toMatchObject({ kind: 'Stale', message: 'a.txt changed since its resolution was undone; staging history was cleared.' });
    // A refused redo left the file as the user has it.
    expect(t.memfs.readFileSync(`${t.dir}/a.txt`, 'utf8')).toBe('edited\n');
    expect((await journalHandlers.stagingState({ repo: 1, worktree: t.dir }, ctx)).off).toBe("Stage and unstage can't be undone while files are conflicted.");
  });

  it('refuses an undo once the file changed since it was resolved, and once the merge ended', async () => {
    const a = await conflicted();
    await resolve(a.ctx, a.t.dir, 'a.txt', { kind: 'incoming' });
    await a.t.write('a.txt', 'edited\n');
    await expect(journalHandlers.stagingUndo({ repo: 1, worktree: a.t.dir }, a.ctx)).rejects.toMatchObject({ kind: 'Stale', message: 'a.txt changed since it was resolved; staging history was cleared.' });
    expect(a.t.memfs.readFileSync(`${a.t.dir}/a.txt`, 'utf8')).toBe('edited\n');
    const b = await conflicted();
    await resolve(b.ctx, b.t.dir, 'a.txt', { kind: 'incoming' });
    b.t.memfs.unlinkSync(`${b.t.dir}/.git/MERGE_HEAD`);
    await expect(journalHandlers.stagingUndo({ repo: 1, worktree: b.t.dir }, b.ctx)).rejects.toMatchObject({ kind: 'Stale', message: RESOLVE_ENDED });
    expect(b.t.memfs.readFileSync(`${b.t.dir}/a.txt`, 'utf8')).toBe('1\nF\n3\n');
  });

  it("writes the markers' length from conflict-marker-size, and knows its own file as untouched", async () => {
    const { t, ctx } = await conflicted('feature', '*.txt conflict-marker-size=9\n');
    expect(t.memfs.readFileSync(`${t.dir}/a.txt`, 'utf8')).toBe('1\n<<<<<<<<< HEAD\nM\n=========\nF\n>>>>>>>>> feature\n3\n');
    await expect(resolve(ctx, t.dir, 'a.txt', { kind: 'asIs' })).rejects.toMatchObject({ detail: { kind: 'markersRemain', path: 'a.txt' } });
    await resolve(ctx, t.dir, 'a.txt', { kind: 'current' });
    expect(t.memfs.readFileSync(`${t.dir}/a.txt`, 'utf8')).toBe('1\nM\n3\n');
  });
});
