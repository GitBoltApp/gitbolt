// The operation a worktree is in the middle of, from its own git dir: gix's `state()` (which file
// means what) and the core's `in_progress::read` (the graph payload's `InProgress`).
import type { InProgress } from '../../../api/gen/InProgress';
import type { MemFs } from '../memfs';
import { parseIndex, type IndexEntry } from '../read/indexFile';
import { seqInProgress, seqOpName, seqShowsHeadMessage } from '../seq/state';
import { unmergedOf } from './index';

export type OpName = 'merge' | 'rebase' | 'cherry-pick' | 'revert' | 'am';

const isFile = (fs: MemFs, gitdir: string, name: string) => kind(fs, `${gitdir}/${name}`) === 'file';
const isDir = (fs: MemFs, gitdir: string, name: string) => kind(fs, `${gitdir}/${name}`) === 'dir';

function kind(fs: MemFs, path: string): 'file' | 'dir' | null {
  try {
    return fs.statSync(path).isDirectory() ? 'dir' : 'file';
  } catch {
    return null;
  }
}

/** gix's `state()`, in its order: a rebase-apply or rebase-merge folder, then the single-commit heads, a bisect before a revert. */
function state(fs: MemFs, gitdir: string): OpName | 'bisect' | 'am-rebase' | null {
  if (isDir(fs, gitdir, 'rebase-apply')) return isFile(fs, gitdir, 'rebase-apply/rebasing') ? 'rebase' : isFile(fs, gitdir, 'rebase-apply/applying') ? 'am' : 'am-rebase';
  if (isDir(fs, gitdir, 'rebase-merge')) return 'rebase';
  if (isFile(fs, gitdir, 'CHERRY_PICK_HEAD')) return 'cherry-pick';
  if (isFile(fs, gitdir, 'MERGE_HEAD')) return 'merge';
  if (isFile(fs, gitdir, 'BISECT_LOG')) return 'bisect';
  if (isFile(fs, gitdir, 'REVERT_HEAD')) return 'revert';
  return null;
}

/** `write::in_progress_name` of gix's state; a bisect is none. The demo's sequencer first. */
export function inProgressName(fs: MemFs, gitdir: string): OpName | null {
  const seq = seqOpName(fs, gitdir);
  if (seq) return seq;
  const s = state(fs, gitdir);
  return s === 'bisect' || s === null ? null : s === 'am-rebase' ? 'am' : s;
}

/** `in_progress::mid_operation`: the worktree's WIP row shows even when it's clean. */
export function midOperation(fs: MemFs, gitdir: string): boolean {
  if (seqOpName(fs, gitdir) !== null) return true;
  const s = state(fs, gitdir);
  return s !== null && s !== 'bisect';
}

function text(fs: MemFs, path: string): string | null {
  try {
    return (fs.readFileSync(path, 'utf8') as string).trim();
  } catch {
    return null;
  }
}

/** A message file, line endings normalised (§8.2); empty when there's none. */
function message(fs: MemFs, path: string): string {
  try {
    return (fs.readFileSync(path, 'utf8') as string).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  } catch {
    return '';
  }
}

/** The worktree's index, read synchronously: empty when there's none (gix's `index_or_empty`),
 *  null when it can't be read. */
export function indexEntries(fs: MemFs, gitdir: string): IndexEntry[] | null {
  try {
    return fs.existsSync(`${gitdir}/index`) ? parseIndex(fs.readFileSync(`${gitdir}/index`) as Uint8Array) : [];
  } catch {
    return null;
  }
}

/** The conflicted paths in the worktree's index. */
export function conflicted(fs: MemFs, gitdir: string): number {
  return unmergedOf(indexEntries(fs, gitdir) ?? []).size;
}

/** The stop shows HEAD's message, which the caller reads for `readInProgress`: git's `edit` stop
 *  (`rebase-merge/amend`), or the sequencer's conflict at a fold. */
export function showsHeadMessage(fs: MemFs, gitdir: string): boolean {
  return fs.existsSync(`${gitdir}/rebase-merge/amend`) || seqShowsHeadMessage(fs, gitdir);
}

/** The last todo line git stopped at (`last_done`). */
function lastDone(fs: MemFs, gitdir: string): string | null {
  try {
    const lines = (fs.readFileSync(`${gitdir}/rebase-merge/done`, 'utf8') as string).split('\n').map((l) => l.trim());
    return lines.findLast((l) => l !== '' && !l.startsWith('#')) ?? null;
  } catch {
    return null;
  }
}

/** The text of the note `name` when it's this stop's (`stop_note`). */
function stopNote(fs: MemFs, gitdir: string, name: string, at: string): string | null {
  let t: string;
  try {
    t = fs.readFileSync(`${gitdir}/${name}`, 'utf8') as string;
  } catch {
    return null;
  }
  const nl = t.indexOf('\n');
  return (nl < 0 ? t : t.slice(0, nl)) === at ? (nl < 0 ? '' : t.slice(nl + 1)).trimEnd() : null;
}

/** `headMessage`: the HEAD commit's raw message, which an edit stop (`rebase-merge/amend`) shows; the caller reads it (`showsHeadMessage`). */
export function readInProgress(fs: MemFs, gitdir: string, headMessage: string | null = null): InProgress | null {
  // The demo's sequencer (plan 4) first: its rebase, pick or revert reads as the core reads git's.
  const seq = seqInProgress(fs, gitdir, headMessage);
  if (seq) return seq;
  const s = state(fs, gitdir);
  if (s === null || s === 'bisect') return null;
  const name: OpName = s === 'am-rebase' ? 'rebase' : s;
  const n = conflicted(fs, gitdir);
  switch (name) {
    case 'merge':
      return { kind: 'merge', mergeHead: (text(fs, `${gitdir}/MERGE_HEAD`) ?? '').split('\n')[0], message: message(fs, `${gitdir}/MERGE_MSG`), conflicted: n };
    case 'cherry-pick':
      return { kind: 'cherryPick', head: text(fs, `${gitdir}/CHERRY_PICK_HEAD`), message: message(fs, `${gitdir}/MERGE_MSG`), conflicted: n };
    case 'revert':
      return { kind: 'revert', head: text(fs, `${gitdir}/REVERT_HEAD`), message: message(fs, `${gitdir}/MERGE_MSG`), conflicted: n };
    case 'am':
      return { kind: 'other', what: 'am' };
    case 'rebase': {
      // Plan 4 (the rebase plan) fills GitVolt's own Edit-stop notes; git's files are read here.
      const merge = isDir(fs, gitdir, 'rebase-merge');
      const dir = `${gitdir}/${merge ? 'rebase-merge' : 'rebase-apply'}`;
      const num = (f: string) => Number(text(fs, `${dir}/${f}`) ?? 0) || 0;
      const editStop = merge ? text(fs, `${dir}/amend`) : null;
      const last = merge ? lastDone(fs, gitdir) : null;
      const messageFailed = last === null ? null : stopNote(fs, gitdir, 'rebase-merge/gitvolt-message-failed', last);
      let msg = editStop !== null ? (headMessage ?? '').replace(/\r\n/g, '\n').replace(/\r/g, '\n') : message(fs, `${dir}/${merge ? 'message' : 'final-commit'}`);
      // The refused message prefills the box.
      if (messageFailed !== null && last !== null) {
        const refused = stopNote(fs, gitdir, 'rebase-merge/gitvolt-refused', last);
        if (refused !== null) {
          const m = refused.slice(refused.indexOf('\n') + 1);
          msg = `${(refused.includes('\n') ? m : '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').trimEnd()}\n`;
        }
      }
      return {
        kind: 'rebase',
        onto: text(fs, `${dir}/onto`) ?? '',
        headName: text(fs, `${dir}/head-name`) ?? '',
        step: merge ? num('msgnum') : num('next'),
        total: merge ? num('end') : num('last'),
        stoppedAt: text(fs, `${dir}/stopped-sha`) ?? text(fs, `${gitdir}/REBASE_HEAD`),
        editStop,
        editBase: null,
        editAdded: [],
        editChanged: false,
        editConflict: editStop === null && last !== null && ['edit', 'e'].includes(last.split(/\s+/)[0]),
        messageFailed,
        gitvolt: false,
        conflicted: n,
        message: msg,
      };
    }
  }
}

/** `resolve_step::operation`: the stop a resolution was made in, as a key (a resolution is undone only within it). */
export function operationKey(fs: MemFs, gitdir: string): string | null {
  const s = readInProgress(fs, gitdir);
  if (s === null) return null;
  switch (s.kind) {
    case 'merge':
      return `merge ${s.mergeHead}`;
    case 'rebase':
      return `rebase ${s.onto} ${s.headName} ${s.step} ${s.stoppedAt ?? ''}`;
    case 'cherryPick':
      return `cherry-pick ${s.head ?? ''}`;
    case 'revert':
      return `revert ${s.head ?? ''}`;
    case 'other':
      return `other ${s.what}`;
  }
}
