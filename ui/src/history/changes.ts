import type { BlobSource } from '../api/gen/BlobSource';
import type { DiffSpec } from '../api/gen/DiffSpec';
import type { FileChange } from '../api/gen/FileChange';
import type { FileHistoryRow } from '../api/gen/FileHistoryRow';
import type { DiffSides } from '../diff/markdownDiffSides';
import { filesKey } from '../repo/services';
import { targetFor, type DiffTarget } from '../repo/store';

/** File History's Changes: the diff a row's commit made to the file, and the commits its
 * Markdown sides resolve links against (5C, R9). */
export type ChangesTarget = DiffTarget & { sides: DiffSides };

/** The row's commit against its first parent, as Diff View shows a commit (a merge included). */
export const changesSpec = (row: FileHistoryRow): DiffSpec => ({ kind: 'commit', id: row.sha, parent: 0 });

const renamed = (row: FileHistoryRow) => row.oldPath !== null && row.oldPath !== row.path;

/** Whether the row's sides come from its commit's file list: a rename or copy, whose old side is
 * at another path, and a merge (no change of its own in the history), whose first parent may
 * not have the file at all. Every other row's sides are its commit and its parent at its path. */
export const needsFileList = (row: FileHistoryRow): boolean => renamed(row) || row.status === '' || row.parents.length > 1;

const atCommit = (commit: string): BlobSource => ({ kind: 'atCommit', commit });
const ABSENT: BlobSource = { kind: 'absent' };

/**
 * The selected version against the previous one in this file's history: the commit's first
 * parent's file, at the old path for a rename. An add has no old side, a delete no new side.
 * `files`: the commit's file list for a row that `needsFileList` (`undefined` while it loads,
 * `null` if it couldn't); its entry for the file is Diff View's own target. `null`: still loading.
 * Without an entry (a merge that left the file as its first parent had it, or a list that failed),
 * the sides are the commit and its parent at the row's path; a rename then shows as added.
 */
export function changesTarget(row: FileHistoryRow, files?: readonly FileChange[] | null): ChangesTarget | null {
  const spec = changesSpec(row);
  const parent = row.parents[0] ?? null;
  const sides: DiffSides = { old: row.status === 'A' ? null : parent, new: row.status === 'D' ? null : row.sha };
  if (needsFileList(row)) {
    if (files === undefined) return null;
    const entry = files?.find((f) => f.path === row.path);
    if (entry) return { ...targetFor(entry, spec), sides: { old: entry.status === 'A' ? null : parent, new: entry.status === 'D' ? null : row.sha } };
  }
  const old = row.status === 'A' || !parent || renamed(row) ? ABSENT : atCommit(parent);
  return {
    key: `${filesKey(spec)}|${row.path}`,
    path: row.path,
    oldPath: null,
    status: row.status || 'M',
    old,
    new: row.status === 'D' ? ABSENT : atCommit(row.sha),
    view: 'diff',
    sides: { ...sides, old: old.kind === 'absent' ? null : sides.old },
  };
}
