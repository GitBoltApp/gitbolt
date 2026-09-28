import type { CSSProperties, ReactNode } from 'react';

/** A file change's kind: added, modified, deleted, renamed, plus conflicted/unknown. */
export type StatusKind = 'added' | 'modified' | 'deleted' | 'renamed' | 'conflicted';

/** The status colours, as the `--status-*` tokens in `theme/tokens.css`. */
export const STATUS_COLOR: Record<StatusKind, string> = {
  added: 'var(--status-added)',
  modified: 'var(--status-modified)',
  deleted: 'var(--status-deleted)',
  renamed: 'var(--status-renamed)',
  conflicted: 'var(--status-conflicted)',
};

/** Git's status letters, spelled out. */
export const STATUS_NAMES: Record<string, string> = { A: 'Added', C: 'Copied', D: 'Deleted', M: 'Modified', R: 'Renamed', T: 'Type changed', U: 'Unmerged', X: 'Unknown' };

const KIND_NAMES: Record<StatusKind, string> = { added: 'Added', modified: 'Modified', deleted: 'Deleted', renamed: 'Renamed', conflicted: 'Conflicted' };

/** A git status letter's kind: A and C are added, M and T modified, U and X conflicted. */
export function statusKind(status: string): StatusKind {
  switch (status) {
    case 'A':
    case 'C':
      return 'added';
    case 'D':
      return 'deleted';
    case 'R':
      return 'renamed';
    case 'U':
    case 'X':
      return 'conflicted';
    default:
      return 'modified';
  }
}

const isKind = (s: string): s is StatusKind => Object.hasOwn(KIND_NAMES, s);

// Our own drawings on a 16×16 grid, stroked in the status colour: a plus, a pencil, a minus, a
// curved arrow, and an exclamation mark.
const GLYPH: Record<StatusKind, ReactNode> = {
  added: <path d="M8 3v10M3 8h10" />,
  modified: <><path d="M10.5 2.5l3 3L6 13H3v-3z" /><path d="M9 4l3 3" /></>,
  deleted: <path d="M3 8h10" />,
  renamed: <><path d="M3 13V9.5A4.5 4.5 0 0 1 7.5 5H13" /><path d="M10 2l3 3-3 3" /></>,
  conflicted: <><path d="M8 3v6" /><path d="M8 12.5v.5" /></>,
};

/**
 * A file's change status as a small inline icon (feedback F17), shared by the file list and the
 * diff view. `status` is a git letter (`A`, `M`, …) or a kind name. Named by its status unless
 * `decorative` (its container names it, e.g. the counts row).
 */
export function StatusIcon({ status, size = 14, decorative = false, style }: { status: string; size?: number; decorative?: boolean; style?: CSSProperties }) {
  const kind = isKind(status) ? status : statusKind(status);
  const label = isKind(status) ? KIND_NAMES[kind] : STATUS_NAMES[status] ?? status;
  return (
    <svg
      className="status-icon"
      data-status={kind}
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ color: STATUS_COLOR[kind], flex: 'none', ...style }}
      {...(decorative ? { 'aria-hidden': true } : { role: 'img', 'aria-label': label })}
    >
      {!decorative && <title>{label}</title>}
      {GLYPH[kind]}
    </svg>
  );
}
