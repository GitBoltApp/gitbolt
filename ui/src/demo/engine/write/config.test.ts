import { describe, expect, it } from 'vitest';
import { makeTestRepo } from '../read/testkit';
import { applyConfigChanges, branchConfig, configChanges, readLocalConfig, removeBranchSection, removeConfigSection, renameBranchSection, setConfigValues } from './config';

describe("a branch's config", () => {
  it('sets, reads, renames and removes branch sections as git writes them', async () => {
    const t = await makeTestRepo();
    const demo = t.repo.demo!;
    setConfigValues(demo, 'branch.feature/x.remote', ['origin']);
    setConfigValues(demo, 'branch.feature/x.merge', ['refs/heads/feature/x']);
    setConfigValues(demo, 'branch.feature/x.merge', ['refs/heads/other']);
    expect([...branchConfig(demo, 'feature/x')]).toEqual([['branch.feature/x.remote', ['origin']], ['branch.feature/x.merge', ['refs/heads/other']]]);
    expect(await demo.config('branch.feature/x.remote')).toBe('origin');
    const text = t.memfs.readFileSync(`${demo.gitdir}/config`, 'utf8') as string;
    expect(text).toContain('[branch "feature/x"]\n\tremote = origin\n\tmerge = refs/heads/other\n');
    renameBranchSection(demo, 'feature/x', 'feature/y');
    expect(branchConfig(demo, 'feature/x').size).toBe(0);
    expect(await demo.config('branch.feature/y.merge')).toBe('refs/heads/other');
    removeBranchSection(demo, 'feature/y');
    expect(branchConfig(demo, 'feature/y').size).toBe(0);
    expect(t.memfs.readFileSync(`${demo.gitdir}/config`, 'utf8')).not.toContain('feature/y');
    // A dotted name keeps its dots: `branch.v1.2.remote` belongs to `v1.2`.
    setConfigValues(demo, 'branch.v1.2.remote', ['origin']);
    expect([...branchConfig(demo, 'v1.2').keys()]).toEqual(['branch.v1.2.remote']);
    expect(branchConfig(demo, 'v1').size).toBe(0);
  });

  it("lists every key whose values differ in git's order, and replays them both ways", async () => {
    const t = await makeTestRepo();
    const demo = t.repo.demo!;
    const before = new Map([['branch.b.rebase', ['true']]]);
    const after = new Map([['branch.b.rebase', ['true']], ['branch.b.merge', ['refs/heads/b']], ['branch.b.remote', ['origin']], ['branch.b.description', ['x']]]);
    const changes = configChanges(before, after);
    expect(changes.map((c) => c.key)).toEqual(['branch.b.remote', 'branch.b.merge', 'branch.b.description']);
    applyConfigChanges(demo, changes, false);
    expect(await demo.config('branch.b.merge')).toBe('refs/heads/b');
    applyConfigChanges(demo, changes, true);
    expect(await demo.config('branch.b.merge')).toBeNull();
    expect(branchConfig(demo, 'b').size).toBe(0);
  });

  it("quotes values as git does and drops an emptied section", async () => {
    const t = await makeTestRepo();
    const demo = t.repo.demo!;
    for (const [k, v] of [['a', 'a"b'], ['b', 'a\\b'], ['c', ' lead'], ['d', 'a#b']]) setConfigValues(demo, `branch.x.${k}`, [v]);
    const text = t.memfs.readFileSync(`${demo.gitdir}/config`, 'utf8') as string;
    expect(text).toContain('[branch "x"]\n\ta = a\\"b\n\tb = a\\\\b\n\tc = " lead"\n\td = "a#b"\n');
    for (const k of ['a', 'b', 'c', 'd']) setConfigValues(demo, `branch.x.${k}`, []);
    expect(t.memfs.readFileSync(`${demo.gitdir}/config`, 'utf8')).not.toContain('branch');
  });

  it("edits remote sections and plain ones as git does, and lists the file as `config --list`", async () => {
    const t = await makeTestRepo();
    const demo = t.repo.demo!;
    const before = readLocalConfig(demo);
    setConfigValues(demo, 'remote.origin.url', ['/x/o.git']);
    setConfigValues(demo, 'remote.origin.fetch', ['+refs/heads/*:refs/remotes/origin/*']);
    setConfigValues(demo, 'remote.pushDefault', ['origin']);
    setConfigValues(demo, 'branch.Main.remote', ['origin']);
    const text = t.memfs.readFileSync(`${demo.gitdir}/config`, 'utf8') as string;
    expect(text).toContain('[remote "origin"]\n\turl = /x/o.git\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n[remote]\n\tpushDefault = origin\n[branch "Main"]\n\tremote = origin\n');
    expect(readLocalConfig(demo).slice(before.length)).toEqual([
      ['remote.origin.url', '/x/o.git'],
      ['remote.origin.fetch', '+refs/heads/*:refs/remotes/origin/*'],
      ['remote.pushdefault', 'origin'],
      ['branch.Main.remote', 'origin'],
    ]);
    expect(await demo.config('remote.origin.url')).toBe('/x/o.git');
    // Undo of a removal re-adds the keys; its redo takes them away with their sections.
    const changes = [
      { key: 'remote.origin.url', old: ['/x/o.git'], new: [] },
      { key: 'remote.origin.fetch', old: ['+refs/heads/*:refs/remotes/origin/*'], new: [] },
      { key: 'remote.pushdefault', old: ['origin'], new: [] },
    ];
    applyConfigChanges(demo, changes, false);
    expect(t.memfs.readFileSync(`${demo.gitdir}/config`, 'utf8')).not.toContain('[remote');
    applyConfigChanges(demo, changes, true);
    expect(readLocalConfig(demo).filter(([k]) => k.startsWith('remote.'))).toEqual(changes.map((c) => [c.key, c.old[0]]));
    removeConfigSection(demo, 'remote.origin');
    expect(readLocalConfig(demo).filter(([k]) => k.startsWith('remote.'))).toEqual([['remote.pushdefault', 'origin']]);
    expect(readLocalConfig(demo).slice(0, before.length)).toEqual(before);
  });
});
