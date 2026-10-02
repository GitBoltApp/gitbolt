import type { ConflictKind } from '../api/gen/ConflictKind';
import type { FileListPayload } from '../api/gen/FileListPayload';

export const CONFLICT_TEXT: Record<ConflictKind, string> = {
  bothModified: 'both modified',
  bothAdded: 'both added',
  bothDeleted: 'both deleted',
  addedByUs: 'added by us',
  addedByThem: 'added by them',
  deletedByUs: 'deleted by us',
  deletedByThem: 'deleted by them',
};

const totals = (files: FileListPayload['files']): FileListPayload => ({
  files,
  added: files.reduce((n, f) => n + (f.additions ?? 0), 0),
  deleted: files.reduce((n, f) => n + (f.deletions ?? 0), 0),
});

/** §7.1: conflicted files (status `U`) go in Conflicted, and in neither of the other sections.
 * A list with none keeps its own totals; one that loses some is recounted. */
export function splitConflicted(unstaged: FileListPayload, staged: FileListPayload): { conflicted: FileListPayload; unstaged: FileListPayload; staged: FileListPayload } {
  const isU = (f: { status: string }) => f.status === 'U';
  const without = (l: FileListPayload): FileListPayload => (l.files.some(isU) ? { ...totals(l.files.filter((f) => !isU(f))), version: l.version } : l);
  return { conflicted: totals(unstaged.files.filter(isU)), unstaged: without(unstaged), staged: without(staged) };
}
