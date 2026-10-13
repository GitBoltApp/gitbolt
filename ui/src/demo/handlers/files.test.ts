import { describe, expect, it } from 'vitest';
import { filesHandlers } from './files';
import { MODE_FILE, MODE_GITLINK } from '../engine/read/trees';
import { fakeCtx, makeTestRepo, setIndex } from '../engine/read/testkit';
import { readIndex } from '../engine/read/indexFile';

async function repo() {
  const t = await makeTestRepo();
  await t.write('a.txt', 'a\n');
  await t.write('docs/guide.txt', 'g\n');
  const root = await t.commit('Root');
  await t.write('a.txt', 'a\nb\n');
  const second = await t.commit('Second');
  await t.branch('side', root);
  await t.checkout('side');
  await t.write('side.txt', 's\n');
  const side = await t.commit('Side');
  await t.checkout('main');
  await t.write('side.txt', 's\n');
  const merge = await t.commit('Merge', undefined, { parents: [second, side] });
  return { t, root, second, side, merge, ctx: fakeCtx(t.repo) };
}

describe('file handlers', () => {
  it('lists a commit against the parent asked for, and refuses one it doesn\'t have', async () => {
    const { merge, root, ctx } = await repo();
    const first = await filesHandlers.fileList({ repo: 1, spec: { kind: 'commit', id: merge, parent: 0 } }, ctx);
    expect(first.files.map((f) => f.path)).toEqual(['side.txt']);
    const second = await filesHandlers.fileList({ repo: 1, spec: { kind: 'commit', id: merge, parent: 1 } }, ctx);
    expect(second).toMatchObject({ added: 1, deleted: 0 });
    expect(second.files.map((f) => f.path)).toEqual(['a.txt']);
    expect('version' in second).toBe(false);
    const rootList = await filesHandlers.fileList({ repo: 1, spec: { kind: 'commit', id: root, parent: 0 } }, ctx);
    expect(rootList.files.every((f) => f.status === 'A' && f.old.kind === 'absent')).toBe(true);
    await expect(filesHandlers.fileList({ repo: 1, spec: { kind: 'commit', id: merge, parent: 2 } }, ctx)).rejects.toMatchObject({ kind: 'InvalidInput', message: `commit ${merge} has 2 parent(s); there is no parent 3` });
    await expect(filesHandlers.fileList({ repo: 1, spec: { kind: 'compare', from: '--output=/tmp/x', to: merge } }, ctx)).rejects.toMatchObject({ kind: 'InvalidInput' });
    await expect(filesHandlers.fileList({ repo: 1, spec: { kind: 'wip', worktree: '/elsewhere', staged: true } }, ctx)).rejects.toMatchObject({ kind: 'InvalidInput' });
  });

  it('lists every file at a commit, and the worktree\'s tracked files without gitlinks', async () => {
    const { t, merge, ctx } = await repo();
    expect(await filesHandlers.treeFiles({ repo: 1, id: merge }, ctx)).toEqual(['a.txt', 'docs/guide.txt', 'side.txt']);
    const entries = await readIndex(t.repo, t.repo.gitdir);
    await setIndex(t, [...entries, { path: 'libs/x', mode: MODE_GITLINK, oid: merge, stage: 0 }, { path: 'c.txt', mode: MODE_FILE, oid: merge, stage: 2 }, { path: 'c.txt', mode: MODE_FILE, oid: merge, stage: 3 }]);
    expect(await filesHandlers.worktreeFiles({ repo: 1, worktree: t.dir }, ctx)).toEqual(['a.txt', 'c.txt', 'docs/guide.txt', 'side.txt']);
    await expect(filesHandlers.treeFiles({ repo: 1, id: '1'.repeat(40) }, ctx)).rejects.toMatchObject({ kind: 'NotFound' });
  });

  it('says what a pasted path is', async () => {
    const { t, ctx } = await repo();
    const kind = (path: string) => filesHandlers.worktreePathKind({ repo: 1, worktree: t.dir, path }, ctx);
    expect([await kind('docs'), await kind('a.txt'), await kind('nope/x')]).toEqual(['dir', 'file', null]);
    await expect(kind('../x')).rejects.toMatchObject({ kind: 'InvalidInput' });
  });
});
