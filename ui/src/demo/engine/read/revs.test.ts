import * as git from 'isomorphic-git';
import { describe, expect, it } from 'vitest';
import { ancestors, commitsByPrefix, configBool, mergeBaseOf, refsUnder, relation, revParse, stashIds } from './revs';
import { makeTestRepo, stash } from './testkit';

async function history() {
  const t = await makeTestRepo();
  await t.write('a.txt', '1\n');
  const root = await t.commit('Root');
  await t.write('a.txt', '2\n');
  const main1 = await t.commit('Main one');
  await t.branch('side', root);
  await t.checkout('side');
  await t.write('s.txt', 's\n');
  const side1 = await t.commit('Side one');
  await t.checkout('main');
  const merge = await t.commit('Merge side', undefined, { parents: [main1, side1] });
  await git.annotatedTag({ fs: t.memfs, dir: t.dir, ref: 'v1.0', object: root, message: 'Release', tagger: { name: 'Ada Lovelace', email: 'ada@example.com', timestamp: 1_767_225_600, timezoneOffset: 0 } });
  return { t, root, main1, side1, merge };
}

describe('revisions', () => {
  it('parses names, ids, prefixes and ~/^ chains to commits', async () => {
    const { t, root, main1, side1, merge } = await history();
    const r = t.repo;
    expect(await revParse(r, 'HEAD')).toBe(merge);
    expect(await revParse(r, 'main')).toBe(merge);
    expect(await revParse(r, 'refs/heads/side')).toBe(side1);
    expect(await revParse(r, 'v1.0')).toBe(root);
    expect(await revParse(r, 'v1.0^{commit}')).toBe(root);
    expect(await revParse(r, 'HEAD^2')).toBe(side1);
    expect(await revParse(r, 'HEAD~1')).toBe(main1);
    expect(await revParse(r, 'main^^')).toBe(root);
    expect(await revParse(r, merge.slice(0, 7))).toBe(merge);
    expect(await revParse(r, merge.toUpperCase())).toBe(merge);
    await expect(revParse(r, 'nope')).rejects.toMatchObject({ kind: 'NotFound' });
    await expect(revParse(r, 'HEAD~9')).rejects.toMatchObject({ kind: 'NotFound' });
    expect(await commitsByPrefix(r, merge.slice(0, 6))).toEqual([merge]);
  });

  it('counts each side of a relation, and finds the merge base', async () => {
    const { t, root, main1, side1 } = await history();
    expect(await relation(t.repo, main1, side1)).toEqual([1, 1]);
    expect(await mergeBaseOf(t.repo, main1, side1)).toBe(root);
    expect(await mergeBaseOf(t.repo, main1, '0'.repeat(40))).toBeNull();
    expect((await ancestors(t.repo, side1)).size).toBe(2);
  });

  it('lists refs bytewise, reads config booleans and stash ids', async () => {
    const { t } = await history();
    expect((await refsUnder(t.repo, 'refs/heads')).map((x) => x.name)).toEqual(['refs/heads/main', 'refs/heads/side']);
    expect((await refsUnder(t.repo, 'refs/tags')).map((x) => x.name)).toEqual(['refs/tags/v1.0']);
    expect(await configBool(t.repo, 'rebase.updateRefs')).toBeUndefined();
    await git.setConfig({ fs: t.memfs, dir: t.dir, path: 'rebase.updateRefs', value: 'false' });
    expect(await configBool(t.repo, 'rebase.updateRefs')).toBe(false);
    expect(await stashIds(t.repo)).toEqual([]);
    await t.write('a.txt', 'stashed\n');
    const s = await stash(t, 'Experiment');
    expect(await stashIds(t.repo)).toEqual([s]);
  });
});
