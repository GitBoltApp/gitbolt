// Worktrees (write/worktree.rs, spec #2 §11.1): add and remove, neither journaled, and the folder
// the create dialog proposes.
import type { WorktreeAdded } from '../../api/gen/WorktreeAdded';
import type { WorktreeBranch } from '../../api/gen/WorktreeBranch';
import type { WorktreeRemoveOutcome } from '../../api/gen/WorktreeRemoveOutcome';
import { branchNameError } from '../../branches/branchName';
import type { HandlerTable } from '../transport';
import { basename } from '../engine/paths';
import { normalisePath, parentOf } from '../engine/memfs';
import { fail, readRepoOf } from '../engine/read/seam';
import { revParse } from '../engine/read/revs';
import { listFiles } from '../engine/read/trees';
import { listWorktrees } from '../engine/read/worktrees';
import { checkedOutElsewhere, displayWorktree } from '../engine/write/checkedOut';
import { checkoutEntry } from '../engine/write/files';
import { saveIndex, type IndexEntry } from '../engine/write/index';
import { casRefs, readRef } from '../engine/write/refs';
import { runWrite, type WriteIntent } from '../engine/write/run';
import { writeTarget, type WriteWt } from '../engine/write/seam';
import { statusEntries } from '../engine/write/status';
import { compareBytewise } from '../engine/read/bytes';
import { gitFailure } from '../engine/errors';
import { heads, upstreamKeysOrFail, writeUpstreamKeys } from './branches';
import { NO_EXPECT } from './stage';

export function suggestWorktreePath(mainRoot: string, branch: string, taken: (p: string) => boolean): string {
  const base = `${parentOf(mainRoot)}/${basename(mainRoot)}-${branch.replaceAll('/', '-')}`;
  if (!taken(base)) return base;
  for (let n = 2; ; n++) if (!taken(`${base}-${n}`)) return `${base}-${n}`;
}

async function mainRootOf(wt: WriteWt): Promise<string> {
  return (await listWorktrees(wt.repo)).find((w) => w.isMain)?.path ?? wt.repo.dir;
}

const nameOf = (b: WorktreeBranch) => b.name;

/** An absolute path with its trailing slash and `..` resolved (a relative one is refused later). */
const tidy = (path: string) => (path.startsWith('/') ? normalisePath(path) : path);

/** `git worktree add -b`'s refusal of a branch name a branch's folder holds (`a` beside `a/b`), or
 *  under a branch (`a/b` beside `a`): git's words, as the core reports them (its first line). */
function nameClash(wt: WriteWt, name: string): void {
  const full = heads(name);
  const clash = [...wt.demo.refMap().keys()].filter((n) => n.startsWith('refs/heads/') && (n.startsWith(`${full}/`) || full.startsWith(`${n}/`))).sort(compareBytewise)[0];
  if (clash === undefined) return;
  const lock = `cannot lock ref '${full}': '${clash}' exists; cannot create '${full}'`;
  throw gitFailure(`Preparing worktree (new branch '${name}')`, `Preparing worktree (new branch '${name}')\nfatal: ${lock}\n`);
}

function add(path: string, branch: WorktreeBranch, shown: string): WriteIntent<WorktreeAdded> {
  // The new branch's start point and upstream, resolved in the plan so a refusal creates nothing.
  let start = '';
  let upstream: { remote: string; merge: string } | null = null;
  return {
    kind: 'worktree',
    label: () => `add worktree ${shown}`,
    undo: () => null,
    plan: async (pre) => {
      const fs = pre.wt.fs;
      const isDir = (p: string) => {
        try {
          return fs.lstatSync(p).isDirectory();
        } catch {
          return false;
        }
      };
      if (!path.startsWith('/') || !isDir(parentOf(path))) fail('InvalidInput', 'Pick a directory inside an existing directory');
      if (fs.existsSync(path, false) && (!isDir(path) || (fs.readdirSync(path) as string[]).length > 0)) fail('InvalidInput', "That directory isn't empty");
      const name = nameOf(branch);
      const exists = readRef(pre.wt.demo, heads(name)) !== null;
      if (branch.kind === 'existing') {
        if (!exists) fail('NotFound', `No branch ${name}`);
        const all = await listWorktrees(pre.wt.repo);
        const w = all.find((x) => x.branch === heads(name));
        if (w) throw checkedOutElsewhere(name, displayWorktree(all.find((m) => m.isMain)?.path ?? pre.wt.repo.dir, w.path));
      } else {
        const why = branchNameError(name);
        if (why) fail('InvalidInput', why);
        if (exists) fail('InvalidInput', `A branch named ${name} already exists`);
      }
      const extra = branch.kind === 'new' ? [branch.at] : branch.kind === 'remote' ? [branch.remote, branch.branch] : [];
      if ([name, ...extra].some((v) => v.startsWith('-'))) fail('InvalidInput', "Names can't start with a dash");
      if (branch.kind === 'new') {
        // Git's own message, which the core maps to `Other`.
        start = await revParse(pre.wt.repo, branch.at, pre.wt.root).catch(() => fail('Other', `invalid reference: ${branch.at}`));
      }
      if (branch.kind === 'remote') {
        const tracking = `refs/remotes/${branch.remote}/${branch.branch}`;
        start = readRef(pre.wt.demo, tracking) ?? fail('NotFound', `No branch ${branch.remote}/${branch.branch}`);
        upstream = await upstreamKeysOrFail(pre.wt.demo, tracking);
      }
      if (branch.kind !== 'existing') nameClash(pre.wt, name);
      return {};
    },
    run: async (cx) => {
      const demo = cx.wt.demo;
      const name = nameOf(branch);
      // `git worktree add -b` makes the branch outside the refs the core's verify watches (the
      // intent names none): no ref move is reported, so no refsUpdated, as the core.
      // Everything was checked in the plan: the branch, then its upstream (git's `--track` order).
      if (branch.kind !== 'existing') casRefs(demo, [{ name: heads(name), old: null, new: start }]);
      if (upstream !== null) writeUpstreamKeys(demo, name, upstream);
      const tip = readRef(demo, heads(name))!;
      // .git/worktrees/<id>: the folder's name, numbered when taken.
      let id = basename(path);
      for (let n = 1; demo.fs.existsSync(`${demo.gitdir}/worktrees/${id}`, false); n++) id = `${basename(path)}${n}`;
      const gitdir = `${demo.gitdir}/worktrees/${id}`;
      demo.fs.mkdirpSync(gitdir);
      demo.fs.mkdirpSync(path);
      demo.fs.writeFileSync(`${path}/.git`, `gitdir: ${gitdir}\n`);
      demo.fs.writeFileSync(`${gitdir}/HEAD`, `ref: ${heads(name)}\n`);
      demo.fs.writeFileSync(`${gitdir}/gitdir`, `${path}/.git\n`);
      demo.fs.writeFileSync(`${gitdir}/commondir`, '../..\n');
      const wt: WriteWt = { repo: cx.wt.repo, demo, fs: demo.fs, root: path, gitdir, isMain: false };
      const entries: IndexEntry[] = [];
      for (const [p, e] of await listFiles(cx.wt.repo, tip)) {
        const stat = await checkoutEntry(wt, p, e);
        entries.push({ path: p, mode: e.mode, oid: e.oid, stage: 0, ...(stat ? { stat } : {}) });
      }
      await saveIndex(wt, entries);
      for (const k of ['head', 'refs', 'config'] as const) cx.touch(k);
      cx.command('worktree', 'add', ...(branch.kind === 'existing' ? [] : ['-b', name]), '--', path);
      return { path };
    },
  };
}

function remove(path: string, force: boolean, shown: string): WriteIntent<WorktreeRemoveOutcome> {
  let gitdir = '';
  return {
    kind: 'worktree',
    label: () => `remove worktree ${shown}`,
    undo: () => null,
    plan: async (pre) => {
      const w = (await pre.wt.demo.worktrees()).find((x) => x.path === path);
      if (!w) fail('NotFound', "That isn't a worktree of this repository");
      if (w.isMain) fail('InvalidInput', "The main worktree can't be removed");
      if (w.locked) fail('InvalidInput', 'This worktree is locked; unlock it first');
      gitdir = (await listWorktrees(pre.wt.repo)).find((x) => x.path === w.path)?.gitdir ?? '';
      return {};
    },
    run: async (cx) => {
      cx.touch('head');
      if (!force && (await statusEntries(cx.wt.repo, path)).length > 0) return { status: 'needsForce', reason: "It has changes that aren't committed" };
      const fs = cx.wt.fs;
      const rm = (p: string) => {
        if (fs.lstatSync(p).isDirectory()) {
          for (const n of fs.readdirSync(p) as string[]) rm(`${p}/${n}`);
          fs.rmdirSync(p);
        } else fs.unlinkSync(p);
      };
      rm(path);
      if (gitdir !== '' && fs.existsSync(gitdir, false)) rm(gitdir);
      // The last one gone takes the folder with it.
      const all = `${cx.wt.demo.gitdir}/worktrees`;
      if (fs.existsSync(all, false) && (fs.readdirSync(all) as string[]).length === 0) fs.rmdirSync(all);
      cx.command('worktree', 'remove', ...(force ? ['--force'] : []), '--', path);
      return { status: 'removed' };
    },
  };
}

export const worktreeHandlers: Pick<HandlerTable, 'worktreeAdd' | 'worktreeRemove' | 'suggestWorktreePath'> = {
  worktreeAdd: async ({ repo, worktree, path: given, branch }, ctx) => {
    const path = tidy(given);
    const main = await mainRootOf(await writeTarget(ctx, repo, worktree));
    // A relative path is refused by the plan; it has no folder to show.
    const shown = path.startsWith('/') ? displayWorktree(main, path) : path;
    return runWrite(ctx, repo, worktree, NO_EXPECT, add(path, branch, shown));
  },
  worktreeRemove: async ({ repo, worktree, path: given, force }, ctx) => {
    const path = tidy(given);
    const main = await mainRootOf(await writeTarget(ctx, repo, worktree));
    // Runs in the main worktree, never the one going away.
    return runWrite(ctx, repo, main, NO_EXPECT, remove(path, force, path.startsWith('/') ? displayWorktree(main, path) : path));
  },
  suggestWorktreePath: async ({ repo, branch }, ctx) => {
    const r = readRepoOf(ctx, repo);
    return suggestWorktreePath(r.dir, branch, (p) => r.demo!.fs.existsSync(p, false));
  },
};
