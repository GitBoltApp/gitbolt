import * as git from 'isomorphic-git';
import { describe, expect, it } from 'vitest';
import { fixedClock } from '../clock';
import { makeTestRepo } from '../read/testkit';
import { MODE_EXEC, MODE_FILE, MODE_LINK } from '../read/trees';
import { cleanupStrip, cleanupWhitespace, demoIdent, EMPTY_TREE, identLine, writeBlobBytes, writeCommitObject, writeIndexTree, writeTagObject, writeTreeOf } from './objects';

const enc = (s: string) => new TextEncoder().encode(s);
// Computed with git 2.53 (`hash-object`, `mktree`, `commit-tree`, `tag -a`) on a scratch repository.
const A_BLOB = '78981922613b2afb6025042ff6bd878ac1994e85'; // "a\n"
const RUN_BLOB = 'f5bdd214e01603ecd6c83be9f66d88579c588ec6'; // "run\n"
const A_TREE = '08585692ce06452da6f82ae66b90d98b55536fca'; // a.txt
const MIXED_TREE = 'fb6442458721f2cbae0a54ced1342784051bf0cd'; // a-b, a/run.sh (exec), link
const FIRST = '08ca2f77dd84d8b5f0606d054d040c1cc9cebd06'; // A_TREE, "First\n", You at 1800000000 +0000
const SECOND = 'd249d373ec90f323794e0de5f0be6e4ca7b74d81'; // A_TREE, parent FIRST, "Second\n", You at 1800000060 +0200
const TAG = '78f333384bfa539b7d24532a5634442cd546e272'; // v1 on FIRST, "v1 notes\n"

describe('objects as git writes them', () => {
  it('writes blobs, trees in git order, commits and tags with git ids', async () => {
    const t = await makeTestRepo();
    expect(await writeBlobBytes(t.repo, enc('a\n'))).toBe(A_BLOB);
    expect(await writeBlobBytes(t.repo, enc('run\n'))).toBe(RUN_BLOB);
    expect(await writeTreeOf(t.repo, [])).toBe(EMPTY_TREE);
    expect(await writeTreeOf(t.repo, [{ path: 'a.txt', mode: MODE_FILE, oid: A_BLOB }])).toBe(A_TREE);
    const mixed = [{ path: 'link', mode: MODE_LINK, oid: A_BLOB }, { path: 'a/run.sh', mode: MODE_EXEC, oid: RUN_BLOB }, { path: 'a-b', mode: MODE_FILE, oid: A_BLOB }];
    expect(await writeTreeOf(t.repo, mixed)).toBe(MIXED_TREE);
    const you = identLine('You', 'you@example.com', 1_800_000_000, 0);
    expect(you).toBe('You <you@example.com> 1800000000 +0000');
    expect(demoIdent(fixedClock(1_800_000_000_999, 0))).toBe(you);
    expect(identLine('You', 'you@example.com', 1_800_000_060, 120)).toBe('You <you@example.com> 1800000060 +0200');
    expect(identLine('You', 'you@example.com', 1, -330)).toBe('You <you@example.com> 1 -0530');
    const first = await writeCommitObject(t.repo, { tree: A_TREE, parents: [], author: you, committer: you, message: 'First\n' });
    expect(first).toBe(FIRST);
    const later = identLine('You', 'you@example.com', 1_800_000_060, 120);
    expect(await writeCommitObject(t.repo, { tree: A_TREE, parents: [FIRST], author: later, committer: later, message: 'Second\n' })).toBe(SECOND);
    expect(await writeTagObject(t.repo, { object: FIRST, name: 'v1', tagger: you, message: 'v1 notes\n' })).toBe(TAG);
    expect((await git.readCommit({ fs: t.memfs, dir: t.dir, oid: SECOND })).commit.parent).toEqual([FIRST]);
  });

  it("writes the index's tree without intent-to-add entries and refuses a conflicted index", async () => {
    const t = await makeTestRepo();
    await writeBlobBytes(t.repo, enc('a\n'));
    const e = (path: string, extra = {}) => ({ path, mode: MODE_FILE, oid: A_BLOB, stage: 0, ...extra });
    expect(await writeIndexTree(t.repo, [e('a.txt'), e('new.txt', { intentToAdd: true })])).toBe(A_TREE);
    await expect(writeIndexTree(t.repo, [e('a.txt', { stage: 2 })])).rejects.toMatchObject({ kind: 'Conflict' });
  });

  it('cleans messages as commit -F (whitespace) and tag -F (strip) do', () => {
    expect(cleanupWhitespace('Sum  \n\n\n# keep\n\nend\n\n')).toBe('Sum\n\n# keep\n\nend\n');
    expect(cleanupWhitespace('\n\n  \nOne\r\nTwo\t\n')).toBe('One\nTwo\n');
    expect(cleanupWhitespace(' \n\t\n')).toBe('');
    expect(cleanupWhitespace('a\v\n\f\nb')).toBe('a\v\n\f\nb\n');
    expect(cleanupStrip('# hash line\nmsg  \n\n\n\nbody\n\n')).toBe('msg\n\nbody\n');
  });
});
