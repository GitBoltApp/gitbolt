import { describe, expect, it } from 'vitest';
import type { InProgress } from '../../../api/gen/InProgress';
import type { GraphPayload } from '../../../api/gen/GraphPayload';
import type { GraphRequest } from '../../gen/GraphRequest';
import { makeTestRepo, setIndex } from '../read/testkit';
import { MODE_FILE } from '../read/trees';
import { inProgressName, midOperation, readInProgress } from './inProgress';

describe('the operation in progress', () => {
  it('reads a merge from its files, with its conflicted paths, and nothing otherwise', async () => {
    const t = await makeTestRepo();
    await t.write('c.txt', 'base\n');
    const head = await t.commit('Base');
    const g = t.repo.gitdir;
    expect([inProgressName(t.memfs, g), midOperation(t.memfs, g), readInProgress(t.memfs, g)]).toEqual([null, false, null]);
    t.memfs.writeFileSync(`${g}/MERGE_HEAD`, `${head}\n`);
    t.memfs.writeFileSync(`${g}/MERGE_MSG`, "Merge branch 'x'\r\n\r\n# Conflicts:\r\n#\tc.txt\r\n");
    await setIndex(t, [1, 2, 3].map((stage) => ({ path: 'c.txt', mode: MODE_FILE, oid: head, stage })));
    expect(readInProgress(t.memfs, g)).toEqual({ kind: 'merge', mergeHead: head, message: "Merge branch 'x'\n\n# Conflicts:\n#\tc.txt\n", conflicted: 1 });
    expect([inProgressName(t.memfs, g), midOperation(t.memfs, g)]).toEqual(['merge', true]);
  });

  it("sends each worktree's state into the graph, and keeps a clean mid-merge worktree's WIP row", async () => {
    const seen: GraphRequest[] = [];
    const t = await makeTestRepo('graphs', () => ({ addCommits: (c) => c.length, build: (r) => (seen.push(r), {} as GraphPayload), walkOrder: () => [] }));
    await t.write('c.txt', 'base\n');
    const head = await t.commit('Base');
    t.memfs.writeFileSync(`${t.repo.gitdir}/MERGE_HEAD`, `${head}\n`);
    t.memfs.writeFileSync(`${t.repo.gitdir}/MERGE_MSG`, "Merge branch 'x'\n");
    await t.repo.demo!.graph({ limit: null });
    expect(seen[0].inProgress).toEqual({ [t.dir]: { kind: 'merge', mergeHead: head, message: "Merge branch 'x'\n", conflicted: 0 } });
    expect(seen[0].wip).toEqual([[0, { modified: 0, added: 0, deleted: 0, renamed: 0, conflicted: 0 }]]);
  });

  it('reads a conflicted rebase -i edit stop (files copied from git), its notes and an edit stop with amend', async () => {
    const t = await makeTestRepo();
    await t.write('f', 'a\n');
    const head = await t.commit('Base');
    const g = t.repo.gitdir;
    const dir = `${g}/rebase-merge`;
    t.memfs.mkdirSync(dir);
    const put = (n: string, v: string) => t.memfs.writeFileSync(`${dir}/${n}`, v);
    put('done', 'edit df342659294cec2619372ad15be4af0009312f01 # third\n');
    put('onto', 'f069d41e059053d7928c204b950e2ad890545c3f\n');
    put('head-name', 'refs/heads/main\n');
    put('msgnum', '1\n');
    put('end', '2\n');
    put('message', 'third\n\n# Conflicts:\n#\tf\n');
    put('stopped-sha', 'df342659294cec2619372ad15be4af0009312f01\n');
    const r = readInProgress(t.memfs, g) as Extract<InProgress, { kind: 'rebase' }>;
    expect([r.kind, r.step, r.total, r.editStop, r.editConflict, r.messageFailed, r.message]).toEqual(['rebase', 1, 2, null, true, null, 'third\n\n# Conflicts:\n#\tf\n']);
    put('gitvolt-message-failed', 'edit df342659294cec2619372ad15be4af0009312f01 # third\nhook said no\n');
    put('gitvolt-refused', 'edit df342659294cec2619372ad15be4af0009312f01 # third\n' + head + '\nrefused text\r\n');
    const f = readInProgress(t.memfs, g) as Extract<InProgress, { kind: 'rebase' }>;
    expect([f.messageFailed, f.message]).toEqual(['hook said no', 'refused text\n']);
    t.memfs.unlinkSync(`${dir}/gitvolt-message-failed`);
    put('amend', `${head}\n`);
    const e = readInProgress(t.memfs, g, 'Head msg\r\n') as Extract<InProgress, { kind: 'rebase' }>;
    expect([e.editStop, e.editConflict, e.message]).toEqual([head, false, 'Head msg\n']);
  });

  it('a bisect is no operation, and a folder where a file is expected is not one', async () => {
    const t = await makeTestRepo();
    await t.write('f', 'a\n');
    await t.commit('Base');
    const g = t.repo.gitdir;
    t.memfs.writeFileSync(`${g}/BISECT_LOG`, 'x\n');
    t.memfs.writeFileSync(`${g}/REVERT_HEAD`, 'a'.repeat(40) + '\n');
    expect([inProgressName(t.memfs, g), midOperation(t.memfs, g), readInProgress(t.memfs, g)]).toEqual([null, false, null]);
    t.memfs.unlinkSync(`${g}/BISECT_LOG`);
    expect(inProgressName(t.memfs, g)).toBe('revert');
    t.memfs.unlinkSync(`${g}/REVERT_HEAD`);
    t.memfs.mkdirSync(`${g}/MERGE_HEAD`);
    expect([inProgressName(t.memfs, g), midOperation(t.memfs, g)]).toEqual([null, false]);
  });
});
