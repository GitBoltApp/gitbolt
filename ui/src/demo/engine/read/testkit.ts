// Test-only: repositories for the read layer's unit tests, built with isomorphic-git on a MemFs and
// opened with 1a's DemoRepo.open, as the demo opens a bundle's files.
import * as git from 'isomorphic-git';
import type { DemoContext } from '../../context';
import { noGraph } from '../../testing';
import type { GraphFactory } from '../layout';
import { MemFs, parentOf } from '../memfs';
import { DemoRepo } from '../repo';
import { serializeIndex, type IndexEntry } from './indexFile';
import { listFiles, readBlobBytes } from './trees';
import { fail, viewOf, type ReadRepo } from './seam';

export interface Who {
  name: string;
  email: string;
}
export const ADA: Who = { name: 'Ada Lovelace', email: 'ada@example.com' };
export const GRACE: Who = { name: 'Grace Hopper', email: 'grace@example.com' };
export const LARS: Who = { name: 'Lars Tidemann', email: 'lars@example.com' };

export interface TestRepo {
  repo: ReadRepo;
  memfs: MemFs;
  dir: string;
  write(path: string, content: string | Uint8Array, opts?: { exec?: boolean }): Promise<void>;
  link(path: string, target: string): Promise<void>;
  remove(path: string): Promise<void>;
  /** `git add` of one path (a deleted one is removed from the index). */
  stage(path: string): Promise<void>;
  /** Stages everything (new, edited and deleted files), then commits; each commit is 60 s after the last. */
  commit(message: string, who?: Who, opts?: { parents?: string[] }): Promise<string>;
  branch(name: string, at?: string): Promise<void>;
  checkout(ref: string): Promise<void>;
  rev(ref: string): Promise<string>;
}

/** `graph`: the layout behind the DemoRepo (the WebAssembly one for a test that walks; `noGraph` otherwise). */
export async function makeTestRepo(name = 'test', graph: GraphFactory = noGraph): Promise<TestRepo> {
  const fs = new MemFs();
  const dir = `/demo/${name}`;
  fs.mkdirpSync(dir);
  await git.init({ fs, dir, defaultBranch: 'main' });
  const demo = await DemoRepo.open(fs, name, graph());
  const repo = viewOf(demo);
  const cache = {};
  let clock = 1_767_225_600;
  return {
    repo,
    memfs: fs,
    dir,
    async write(path, content, opts = {}) {
      const abs = `${dir}/${path}`;
      fs.mkdirpSync(parentOf(abs));
      fs.writeFileSync(abs, content, { mode: opts.exec ? 0o755 : 0o644 });
    },
    async link(path, target) {
      const abs = `${dir}/${path}`;
      fs.mkdirpSync(parentOf(abs));
      fs.symlinkSync(target, abs);
    },
    async remove(path) {
      fs.unlinkSync(`${dir}/${path}`);
    },
    async stage(path) {
      if (fs.existsSync(`${dir}/${path}`, false)) await git.add({ fs, dir, filepath: path, cache });
      else await git.remove({ fs, dir, filepath: path, cache });
    },
    async commit(message, who = ADA, opts = {}) {
      for (const [filepath, , work] of await git.statusMatrix({ fs, dir, cache })) {
        if (work === 0) await git.remove({ fs, dir, filepath, cache });
        else await git.add({ fs, dir, filepath, cache });
      }
      clock += 60;
      const sig = { ...who, timestamp: clock, timezoneOffset: 0 };
      const oid = await git.commit({ fs, dir, message, author: sig, committer: sig, parent: opts.parents, cache });
      await demo.addCommits([oid]); // as a demo write keeps the graph's store current
      return oid;
    },
    async branch(branchName, at) {
      await git.branch({ fs, dir, ref: branchName, object: at });
    },
    async checkout(ref) {
      await git.checkout({ fs, dir, ref, cache, force: true });
    },
    async rev(ref) {
      return git.resolveRef({ fs, dir, ref });
    },
  };
}

/** A `DemoContext` serving `repos` as ids 1, 2, …; nothing else on it is used by the read handlers. */
export function fakeCtx(...repos: ReadRepo[]): DemoContext {
  return {
    repos: {
      get: (id: number) => repos[id - 1]?.demo ?? fail('InvalidInput', `no open repository with id ${id}`),
      manifest: { version: 1, repos: repos.map((r) => ({ name: r.name, file: `${r.name}.gbdemo`, group: null, open: 'tab' })), groups: [] },
      loaded: (name: string) => repos.find((r) => r.name === name)?.demo ?? undefined,
    },
    state: {},
    emit: () => {},
    notInDemo: (what: string) => fail('Other', `Not in the demo: ${what}`),
  } as unknown as DemoContext;
}

/** Replaces an index (the main worktree's unless `gitdir` names another) with `entries`: conflict stages
 *  and gitlinks that isomorphic-git can't write itself. */
export async function setIndex(t: TestRepo, entries: IndexEntry[], gitdir = t.repo.gitdir): Promise<void> {
  t.memfs.writeFileSync(`${gitdir}/index`, await serializeIndex(entries));
}

/** `git worktree add` at `/demo/.extra/<repo>/wt-<name>` (where 1a's packer puts a fixture's linked
 *  worktree), by hand: the files, the index, and git's bookkeeping. */
export async function addWorktree(t: TestRepo, name: string, branch: string): Promise<string> {
  const path = `/demo/.extra/${t.repo.name}/wt-${name}`;
  const gitdir = `${t.repo.gitdir}/worktrees/${name}`;
  const put = (abs: string, data: Uint8Array | string) => {
    t.memfs.mkdirpSync(parentOf(abs));
    t.memfs.writeFileSync(abs, data);
  };
  const entries: IndexEntry[] = [];
  for (const [file, e] of await listFiles(t.repo, await t.rev(branch))) {
    put(`${path}/${file}`, await readBlobBytes(t.repo, e.oid));
    entries.push({ path: file, mode: e.mode, oid: e.oid, stage: 0 });
  }
  put(`${path}/.git`, `gitdir: ${gitdir}\n`);
  put(`${gitdir}/HEAD`, `ref: refs/heads/${branch}\n`);
  put(`${gitdir}/gitdir`, `${path}/.git\n`);
  put(`${gitdir}/commondir`, '../..\n');
  await setIndex(t, entries, gitdir);
  return path;
}

/** A submodule checkout at `path` in `t`'s worktree: its own repository (in `.git/modules/<name>`) with
 *  `files` committed, then a `.git` file pointing there. Returns its HEAD. */
export async function writeNested(t: TestRepo, path: string, name: string, files: Record<string, string>): Promise<string> {
  const fs = t.memfs;
  const dir = `${t.dir}/${path}`;
  const gitdir = `${t.repo.gitdir}/modules/${name}`;
  fs.mkdirpSync(dir);
  await git.init({ fs, dir, gitdir, defaultBranch: 'main' });
  for (const [file, text] of Object.entries(files)) {
    fs.mkdirpSync(parentOf(`${dir}/${file}`));
    fs.writeFileSync(`${dir}/${file}`, text);
    await git.add({ fs, dir, gitdir, filepath: file });
  }
  const sig = { ...ADA, timestamp: 1_767_200_000, timezoneOffset: 0 };
  const head = await git.commit({ fs, dir, gitdir, message: `Start ${name}`, author: sig, committer: sig });
  fs.writeFileSync(`${dir}/.git`, `gitdir: ${gitdir}\n`);
  return head;
}

/** A stash-shaped commit of the worktree (HEAD and the index as parents) on `refs/stash`, with the
 *  reflog line git writes (1a reads the stash list from it); the worktree is left as it is. */
export async function stash(t: TestRepo, message: string): Promise<string> {
  const fs = t.memfs;
  const dir = t.dir;
  const head = await t.rev('HEAD');
  const sig = { ...ADA, timestamp: 1_767_300_000, timezoneOffset: 0 };
  const index = await git.commit({ fs, dir, message: `index on main: ${message}`, author: sig, committer: sig, parent: [head], noUpdateBranch: true });
  for (const [filepath, , work] of await git.statusMatrix({ fs, dir })) if (work !== 0) await git.add({ fs, dir, filepath });
  const id = await git.commit({ fs, dir, message: `On main: ${message}`, author: sig, committer: sig, parent: [head, index], noUpdateBranch: true });
  await git.writeRef({ fs, dir, ref: 'refs/stash', value: id, force: true });
  fs.mkdirpSync(`${t.repo.gitdir}/logs/refs`);
  fs.writeFileSync(`${t.repo.gitdir}/logs/refs/stash`, `${'0'.repeat(40)} ${id} Ada Lovelace <ada@example.com> 1767300000 +0000\tOn main: ${message}\n`);
  return id;
}

/** Thirty numbered lines (`L1`…`L30`), the ones in `changed` reading `L<n> changed`: a file for `-U3` hunk tests. */
export const thirty = (changed: number[]) =>
  Array.from({ length: 30 }, (_, k) => k + 1)
    .map((i) => (changed.includes(i) ? `L${i} changed\n` : `L${i}\n`))
    .join('');

const lines = (v: string[]) => v.map((l) => `${l}\n`).join('');

/** The core's `file_history` fixture: `story.txt` written, edited in its middle, moved (and edited) to
 *  `src/story.txt`, then edited at the top, with an unrelated commit between. */
export async function storyRepo(): Promise<{ t: TestRepo; start: string; middle: string; head: string }> {
  const t = await makeTestRepo();
  const v = ['Once upon a time', 'there was a repository.', 'It had a few commits', 'and a branch or two.', 'Nobody blamed anyone,', 'until the day it moved.', 'The end.', '(really)'];
  await t.write('story.txt', lines(v));
  const start = await t.commit('Start the story', ADA);
  await t.write('other.txt', 'unrelated\n');
  await t.commit('Unrelated change', LARS);
  v[2] = 'It grew a middle part';
  v[3] = 'with a twist or two.';
  await t.write('story.txt', lines(v));
  const middle = await t.commit('Add the middle', GRACE);
  await t.remove('story.txt');
  v[5] = 'until the day it moved under src.';
  await t.write('src/story.txt', lines(v));
  await t.commit('Move the story under src', LARS);
  v[0] = 'Once upon a sharper time';
  await t.write('src/story.txt', lines(v));
  const head = await t.commit('Sharpen the opening', ADA);
  return { t, start, middle, head };
}

/** `f` edited on `main` and on `side`, then merged with both edits kept (`resolve`, the newest commit). */
export async function mergeRepo(): Promise<{ t: TestRepo; base: string; main: string; side: string; merge: string }> {
  const t = await makeTestRepo();
  await t.write('f', 'a\n');
  const base = await t.commit('add f');
  await t.write('f', 'a\nb\n');
  const main = await t.commit('edit f');
  await t.branch('side', base);
  await t.checkout('side');
  await t.write('f', 'a\nc\n');
  const side = await t.commit('side edits f');
  await t.checkout('main');
  await t.write('f', 'a\nb\nc\n');
  const merge = await t.commit('resolve', undefined, { parents: [main, side] });
  return { t, base, main, side, merge };
}
