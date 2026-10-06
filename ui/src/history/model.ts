import type { FileHistoryPage } from '../api/gen/FileHistoryPage';
import type { FileHistoryRow } from '../api/gen/FileHistoryRow';

/** What File History opens on (spec #3 §4.2): `rev` null is the worktree's HEAD (ruling 1).
 * `follow`: opened for a file picked in the right panel while File History was sticky (UX): the
 * keyboard stays in that file list, so ↑/↓ go on stepping through its files. */
export interface FileHistoryArgs { repoId: number; worktree: string; path: string; rev: string | null; blame: boolean; follow?: boolean }

export interface HistoryState {
  args: FileHistoryArgs;
  /** Newest first, every page loaded so far. */
  rows: FileHistoryRow[];
  /** More rows after these (unknown, so true, before the first page). */
  more: boolean;
  loading: boolean;
  error: string | null;
  selected: string | null;
  blame: boolean;
}

export const initialHistory = (args: FileHistoryArgs): HistoryState => ({ args, rows: [], more: true, loading: false, error: null, selected: null, blame: args.blame });

/** A page in: appended (a row already there is skipped), and the first row selected if nothing is. */
export function withPage(s: HistoryState, page: FileHistoryPage): HistoryState {
  const have = new Set(s.rows.map((r) => r.sha));
  const rows = [...s.rows, ...page.rows.filter((r) => !have.has(r.sha))];
  return { ...s, rows, more: page.more, loading: false, error: null, selected: s.selected ?? rows[0]?.sha ?? null };
}

/** ↑ / ↓ in the list. */
export function stepSelection(s: HistoryState, dir: 1 | -1): Partial<HistoryState> {
  const i = s.rows.findIndex((r) => r.sha === s.selected);
  const next = s.rows[Math.max(0, Math.min(s.rows.length - 1, i < 0 ? 0 : i + dir))];
  return next ? { selected: next.sha } : {};
}

export const selectedRow = (s: HistoryState): FileHistoryRow | null => s.rows.find((r) => r.sha === s.selected) ?? null;

/** The list's end (spec #3 §4.2: "Added in <sha>", then "End of history"), once the last page is
 * in; `addedIn` when the oldest row added the file. */
export function historyEnd(s: HistoryState): { addedIn: string | null } | null {
  if (s.more || s.loading || s.error) return null;
  const last = s.rows.at(-1);
  return { addedIn: last?.status === 'A' ? last.sha : null };
}
