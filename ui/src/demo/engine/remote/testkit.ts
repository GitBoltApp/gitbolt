// Test-only: an origin beside a 1b test repository, as Orbital's: a bare git dir at
// /demo/.origins/<name>.git borrowing the repo's objects, the repo's remote `origin` on it.
import * as git from 'isomorphic-git';
import type { TestRepo } from '../read/testkit';
import { alternatesOf, readCommitIn } from './objects';

/** A bare origin at `/demo/.origins/<name>.git` beside `t` (alternates on `t`'s objects), with `t`'s branches pushed, remote `origin` configured and tracking. */
export async function withOrigin(t: TestRepo, branches: string[]): Promise<string> {
  const name = t.dir.split('/').pop()!;
  const origin = `/demo/.origins/${name}.git`;
  await git.init({ fs: t.memfs, dir: origin, bare: true, defaultBranch: 'main' });
  t.memfs.mkdirpSync(`${origin}/objects/info`);
  t.memfs.writeFileSync(`${origin}/objects/info/alternates`, `${t.repo.gitdir}/objects\n`);
  await git.setConfig({ fs: t.memfs, dir: t.dir, path: 'remote.origin.url', value: origin });
  await git.setConfig({ fs: t.memfs, dir: t.dir, path: 'remote.origin.fetch', value: '+refs/heads/*:refs/remotes/origin/*' });
  for (const b of branches) {
    const oid = await t.rev(b);
    await git.writeRef({ fs: t.memfs, gitdir: origin, ref: `refs/heads/${b}`, value: oid, force: true });
    await git.writeRef({ fs: t.memfs, dir: t.dir, ref: `refs/remotes/origin/${b}`, value: oid, force: true });
    await git.setConfig({ fs: t.memfs, dir: t.dir, path: `branch.${b}.remote`, value: 'origin' });
    await git.setConfig({ fs: t.memfs, dir: t.dir, path: `branch.${b}.merge`, value: `refs/heads/${b}` });
  }
  return origin;
}

/** A commit made directly in the origin (someone else's push): its own objects. */
export async function commitInOrigin(t: TestRepo, origin: string, branch: string, file: string, content: string, message: string): Promise<string> {
  const parent = await git.resolveRef({ fs: t.memfs, gitdir: origin, ref: `refs/heads/${branch}` });
  // The parent and its tree may be the origin's own (an earlier commit made here) or borrowed.
  const commit = await readCommitIn(t.memfs, origin, parent);
  let tree: git.TreeEntry[] | null = null;
  for (const gitdir of [origin, ...(await alternatesOf(t.memfs, origin))]) {
    tree ??= await git.readTree({ fs: t.memfs, gitdir, oid: commit.tree }).then((r) => r.tree, () => null);
  }
  if (!tree) throw new Error(`tree ${commit.tree} not found`);
  const blob = await git.writeBlob({ fs: t.memfs, gitdir: origin, blob: new TextEncoder().encode(content) });
  const entries = [...tree.filter((e) => e.path !== file), { mode: '100644', path: file, oid: blob, type: 'blob' as const }].sort((a, b) => (a.path < b.path ? -1 : 1));
  // The parent's subtrees are the repo's: write the new tree into the origin with them as they are.
  const newTree = await git.writeTree({ fs: t.memfs, gitdir: origin, tree: entries });
  const who = { name: 'Noor Achterberg', email: 'noor.achterberg@example.com', timestamp: 1_767_300_000, timezoneOffset: 0 };
  const oid = await git.writeCommit({ fs: t.memfs, gitdir: origin, commit: { tree: newTree, parent: [parent], author: who, committer: who, message: `${message}\n` } });
  await git.writeRef({ fs: t.memfs, gitdir: origin, ref: `refs/heads/${branch}`, value: oid, force: true });
  return oid;
}
