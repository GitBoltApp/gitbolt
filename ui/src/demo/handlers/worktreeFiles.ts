// Saves, applied suggestions, new files and restores from a commit (write/files.rs, write/restore.rs):
// immediate writes journaled as a Restore of their path, so Undo and Redo put either side back.
import type { SaveOutcome } from '../../api/gen/SaveOutcome';
import type { HandlerTable } from '../transport';
import { gbError } from '../engine/errors';
import { blobId } from '../engine/read/bytes';
import { readCommitOrNull } from '../engine/read/commitText';
import { fail } from '../engine/read/seam';
import { entryAt, MODE_EXEC, MODE_GITLINK, modeType, MODE_TREE } from '../engine/read/trees';
import { checkRelative, safeJoin } from '../engine/read/worktree';
import { checkoutEntry, kind, readFileState, throughLink } from '../engine/write/files';
import { loadIndex } from '../engine/write/index';
import { EMPTY_BLOB } from '../engine/write/objects';
import { runWrite, type WriteIntent } from '../engine/write/run';
import type { WriteWt } from '../engine/write/seam';
import { createSnapshot } from '../engine/write/snapshot';
import { statusEntries } from '../engine/write/status';
import { encode, loadForSave } from '../engine/write/textFile';
import { NO_EXPECT } from './stage';

const kindAt = (wt: WriteWt, rel: string) => kind(wt, `${wt.root}/${rel}`);

/** A path inside a nested repository (a submodule, an embedded clone). */
function inNestedRepo(wt: WriteWt, rel: string): boolean {
  const parts = rel.split('/');
  for (let i = 1; i < parts.length; i++) if (wt.fs.existsSync(`${wt.root}/${parts.slice(0, i).join('/')}/.git`, false)) return true;
  return false;
}

/** Whether the index tracks `path`; a conflicted or intent-to-add entry refuses. */
async function tracked(wt: WriteWt, path: string): Promise<boolean> {
  let found = false;
  for (const e of await loadIndex(wt)) {
    if (e.path !== path) continue;
    if (e.stage !== 0) fail('InProgress', `${path} has merge conflicts: resolve it in the merge tool`);
    if (e.intentToAdd) fail('InvalidInput', `${path} is intent-to-add (git add -N): stage it or unstage it first`);
    found = true;
  }
  return found;
}

function save(path: string, text: string, base: string, suggestion: boolean): WriteIntent<SaveOutcome> {
  let checked: { bytes: Uint8Array; mode: number; file: string } | null = null;
  const changed = () => gbError('Stale', `${path} changed on disk`);
  return {
    kind: 'save',
    label: () => (suggestion ? `apply the suggestion to ${path}` : `save ${path}`),
    class: 'immediate',
    undo: () => 'restore',
    allowedInProgress: true,
    staging: 'keep',
    coalesces: !suggestion,
    plan: async (pre) => {
      // The real path (a symlinked folder canonicalised, as the core's `safe_join`): written in place, the link kept.
      const file = await safeJoin(pre.wt.repo, pre.wt.root, path);
      if (inNestedRepo(pre.wt, path)) fail('InvalidInput', `${path} is in a nested repository: edit it there`);
      const loaded = await loadForSave(pre.wt, path, base, 'edit');
      checked = { bytes: encode(text, loaded.decoded.encoding, loaded.decoded.eol, loaded.bom), mode: loaded.mode, file };
      const untracked = (await tracked(pre.wt, path)) ? [] : [path];
      return { snapshot: { paths: [path], untracked } };
    },
    run: async (cx) => {
      const snap = cx.snapshot!;
      const now = readFileState(cx.wt, path);
      if (now === null || (await blobId(now.bytes)) !== base) throw changed();
      cx.partial = true;
      cx.wt.fs.writeFileSync(checked!.file, checked!.bytes, { mode: checked!.mode === MODE_EXEC ? 0o755 : 0o644 });
      cx.after = await createSnapshot(cx.wt, snap.paths, snap.untracked);
      cx.touch('worktree');
      return { hash: await blobId(checked!.bytes) };
    },
  };
}

function createFile(path: string): WriteIntent<SaveOutcome> {
  const bad = (why: string) => gbError('InvalidInput', `${path} ${why}`);
  let paths: string[] = [];
  return {
    kind: 'save',
    label: () => `create ${path}`,
    class: 'immediate',
    undo: () => 'restore',
    allowedInProgress: true,
    staging: 'keep',
    plan: async (pre) => {
      checkRelative(path);
      const parts = path.split('/');
      const made: string[] = [];
      for (let i = 0; i < parts.length - 1; i++) {
        const dir = parts.slice(0, i + 1).join('/');
        const k = kindAt(pre.wt, dir);
        if (k === 'link') throw bad('goes through a symbolic link');
        if (k === 'file') throw bad(`can't be made: ${dir} is a file`);
        if (k === 'dir' && pre.wt.fs.existsSync(`${pre.wt.root}/${dir}/.git`, false)) throw bad('is in a nested repository: create it there');
        if (k === null) made.push(dir);
      }
      if (kindAt(pre.wt, path) !== null) throw bad('already exists');
      paths = [path, ...made.reverse()];
      return { snapshot: { paths, untracked: paths } };
    },
    run: async (cx) => {
      const file = `${cx.wt.root}/${path}`;
      cx.partial = true;
      cx.wt.fs.mkdirpSync(file.slice(0, file.lastIndexOf('/')));
      if (cx.wt.fs.existsSync(file, false)) throw bad('already exists');
      cx.wt.fs.writeFileSync(file, new Uint8Array(), { mode: 0o644 });
      cx.after = await createSnapshot(cx.wt, paths, paths);
      cx.touch('worktree');
      return { hash: EMPTY_BLOB };
    },
  };
}

function restoreFile(sha: string, path: string, confirm: boolean): WriteIntent<null> {
  const short = sha.slice(0, 7);
  let label = `restore ${path} from ${short}`;
  let entry: { mode: number; oid: string } | null = null;
  const untrackedOf = async (wt: WriteWt) => (kindAt(wt, path) !== null && !(await loadIndex(wt)).some((e) => e.path === path) ? [path] : []);
  return {
    kind: 'restore',
    label: () => label,
    class: 'immediate',
    undo: () => 'restore',
    staging: 'keep',
    plan: async (pre) => {
      const c = await readCommitOrNull(pre.wt.repo, sha);
      if (c === null) fail('NotFound', `${short}: no such commit`);
      // The core would delete through the link; refusing is safer, in git restore's words (the core classifies them NotFound).
      if (throughLink(pre.wt, path)) fail('NotFound', `pathspec '${path}' did not match any file(s) known to git`);
      const e = await entryAt(pre.wt.repo, c.tree, path);
      if (e && modeType(e.mode) === MODE_TREE) fail('InvalidInput', `${path} is a directory in ${short}`);
      if (e && modeType(e.mode) === MODE_GITLINK) fail('InvalidInput', `${path} is a submodule: restore it inside it`);
      const here = kindAt(pre.wt, path);
      if (here === 'dir') fail('InvalidInput', `${path} is a directory in the working tree`);
      if (e === null && here === null) fail('InvalidInput', `${path} isn't in the working tree: nothing to delete`);
      const untracked = await untrackedOf(pre.wt);
      const changes = untracked.length > 0 || (await statusEntries(pre.wt.repo, pre.wt.root)).some((s) => s.path === path && s.worktree !== '.');
      if (!confirm && changes) throw { ...gbError('DirtyWorktree', `Replace your changes to ${path}?`), detail: { kind: 'restoreOverChanges', path } };
      entry = e;
      label = e ? `restore ${path} from ${short}` : `delete ${path} (as in ${short})`;
      return { snapshot: { paths: [path], untracked } };
    },
    run: async (cx) => {
      const snap = cx.snapshot!;
      cx.partial = true;
      if (entry) {
        await checkoutEntry(cx.wt, path, entry);
        cx.command('restore', `--source=${sha}`, '--worktree', '--', path);
      } else if (snap.paths.includes(path) && kindAt(cx.wt, path) !== 'dir') cx.wt.fs.unlinkSync(`${cx.wt.root}/${path}`);
      cx.after = await createSnapshot(cx.wt, snap.paths, await untrackedOf(cx.wt));
      cx.touch('worktree');
      return null;
    },
  };
}

export const worktreeFileHandlers: Pick<HandlerTable, 'writeWorktreeFile' | 'applySuggestion' | 'createWorktreeFile' | 'restoreFile'> = {
  writeWorktreeFile: async ({ repo, worktree, path, text, base }, ctx) => runWrite(ctx, repo, worktree, NO_EXPECT, save(path, text, base, false)),
  applySuggestion: async ({ repo, worktree, path, text, base, expect }, ctx) => runWrite(ctx, repo, worktree, expect, save(path, text, base, true)),
  createWorktreeFile: async ({ repo, worktree, path }, ctx) => runWrite(ctx, repo, worktree, NO_EXPECT, createFile(path)),
  restoreFile: async ({ repo, worktree, sha, path, confirm }, ctx) => {
    checkRelative(path);
    if (!/^[0-9a-fA-F]{40}$/.test(sha)) fail('InvalidInput', `not an object id: ${sha}`);
    return runWrite(ctx, repo, worktree, NO_EXPECT, restoreFile(sha, path, confirm === true));
  },
};
