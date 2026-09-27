import { useVirtualizer } from '@tanstack/react-virtual';
import { ChevronDown, ChevronRight, Folder } from 'lucide-react';
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react';
import { errorMessage } from '../api/client';
import type { DiffSpec } from '../api/gen/DiffSpec';
import type { FileChange } from '../api/gen/FileChange';
import type { FileListPayload } from '../api/gen/FileListPayload';
import { filesKey } from '../repo/services';
import { useRepoView, type DiffTarget } from '../repo/store';
import { useFileListPrefs } from './fileListPrefs';
import { allFolderPaths, buildRows, countByStatus, type FileListMode, type FileRow } from './fileTree';
import './files.css';

/** One file-list row (plan 1B global constraints). */
export const FILE_ROW_H = 24;

const STATUS_NAMES: Record<string, string> = { A: 'Added', C: 'Copied', D: 'Deleted', M: 'Modified', R: 'Renamed', T: 'Type changed', U: 'Unmerged', X: 'Unknown' };

/** "View all files": every path in `commit`'s tree (null until loaded), or the load's error. */
function useTreePaths(commit: string | null) {
  const services = useRepoView((s) => s.services);
  const [state, setState] = useState<{ commit: string; paths: string[] | null; error: string | null } | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!commit) return;
    let live = true;
    services.treeFiles.get(commit).then(
      (paths) => { if (live) setState({ commit, paths, error: null }); },
      (e: unknown) => { if (live) setState({ commit, paths: null, error: errorMessage(e) }); },
    );
    return () => { live = false; };
  }, [commit, services, attempt]);
  const mine = commit && state?.commit === commit ? state : null;
  return {
    paths: mine?.paths ?? null,
    error: mine?.error ?? null,
    retry: () => {
      setState(null);
      setAttempt((n) => n + 1);
    },
  };
}

const stats = (c: FileChange | null) => (!c ? '' : c.additions === null ? 'binary' : `+${c.additions} −${c.deletions ?? 0}`);

function StatusBadge({ status }: { status: string }) {
  if (!status) return <span className="status-badge status-none" aria-hidden="true" />;
  const name = STATUS_NAMES[status] ?? status;
  return <span className={`status-badge status-${status}`} role="img" aria-label={name} title={name}>{status}</span>;
}

function Row({ id, row, mode, active, top, onMouseDown }: { id: string; row: FileRow; mode: FileListMode; active: boolean; top: number; onMouseDown: (e: MouseEvent) => void }) {
  const style = { top, height: FILE_ROW_H, paddingLeft: 8 + row.depth * 14 };
  if (row.kind === 'folder') {
    return (
      <div id={id} role="option" aria-selected={active} aria-expanded={row.expanded} data-kind="folder" data-path={row.path} className="file-row" style={style} onMouseDown={onMouseDown}>
        {row.expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        <Folder size={12} className="dim" />
        <span className="file-name">{row.name}</span>
      </div>
    );
  }
  const c = row.change;
  const s = stats(c);
  return (
    <div id={id} role="option" aria-selected={active} data-kind="file" data-path={row.target.path} className={c ? 'file-row' : 'file-row unchanged'} style={style} title={s || undefined} onMouseDown={onMouseDown}>
      <StatusBadge status={c?.status ?? ''} />
      {c?.oldPath && <span className="file-dir">{c.oldPath} → </span>}
      {(mode === 'path' || c?.oldPath) && row.dir && <span className="file-dir">{row.dir}/</span>}
      <span className="file-name">{row.name}</span>
      {s && (
        <span className="file-stats">
          {c?.additions === null ? 'binary' : <><span className="added">+{c?.additions}</span> <span className="deleted">−{c?.deletions}</span></>}
        </span>
      )}
    </div>
  );
}

/**
 * The active row: the keyboard cursor while the diff it was set for is still open, else the
 * open file's row, else (its folder collapsed) the deepest visible folder holding it.
 */
function activeRowId(rows: FileRow[], cursor: Cursor | null, open: { key: string; path: string } | null, own: boolean): string | null {
  const openKey = open?.key ?? null;
  if (cursor && cursor.diffKey === openKey && rows.some((r) => r.id === cursor.id)) return cursor.id;
  if (!own || !open) return null;
  const row = rows.find((r) => r.kind === 'file' && r.target.key === open.key);
  if (row) return row.id;
  let folder: FileRow | null = null;
  for (const r of rows) if (r.kind === 'folder' && open.path.startsWith(`${r.path}/`) && (!folder || r.depth > folder.depth)) folder = r;
  return folder?.id ?? null;
}

/** Where the keyboard is, and the open diff (its key) at the moment it was put there. */
interface Cursor { id: string; diffKey: string | null }

/**
 * A virtualized file list (spec §9.3): header counts, Path/Tree, View all files, sort, and rows
 * that open their diff on click or on Up/Down (no separate Enter step). Opening a file prefetches
 * its neighbours' contents; the prefetch queue is replaced on every move, so files the user has
 * moved past are dropped before they're requested (plan 1B deviation 2).
 *
 * The listbox carries `data-open-file` when it holds the open file and `data-empty` when it has
 * no rows, so the files zone can focus the right list (WIP has two).
 */
export function FileList({ list, spec, label, allFilesCommit = null }: { list: FileListPayload; spec: DiffSpec; label: string; allFilesCommit?: string | null }) {
  const openFile = useRepoView((s) => s.openFile);
  const setFocus = useRepoView((s) => s.setFocus);
  const openKey = useRepoView((s) => s.diff?.key ?? null);
  const openPath = useRepoView((s) => s.diff?.path ?? null);
  const diffOpen = openKey !== null;
  const { mode, sort, allFiles, set: setPrefs } = useFileListPrefs();
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const [cursor, setCursor] = useState<Cursor | null>(null);
  const tree = useTreePaths(allFiles ? allFilesCommit : null);
  const paths = tree.paths;
  const unchanged = useMemo(() => (allFiles && allFilesCommit && paths ? { commit: allFilesCommit, paths } : null), [allFiles, allFilesCommit, paths]);
  const rows = useMemo(() => buildRows({ files: list.files, spec, unchanged, mode, sort, collapsed }), [list.files, spec, unchanged, mode, sort, collapsed]);
  // Every target key of this list starts with its spec's key (`targetFor`, `fileViewTarget`).
  const own = openKey !== null && openKey.startsWith(`${filesKey(spec)}|`);
  const activeId = activeRowId(rows, cursor, openKey !== null && openPath !== null ? { key: openKey, path: openPath } : null, own);
  const scrollRef = useRef<HTMLDivElement>(null);
  const baseId = useId();
  const v = useVirtualizer({ count: rows.length, getScrollElement: () => scrollRef.current, estimateSize: () => FILE_ROW_H, overscan: 12, initialRect: { width: 400, height: 400 } });
  const counts = countByStatus(list.files);
  const items = v.getVirtualItems();
  const activeIndex = rows.findIndex((r) => r.id === activeId);
  const rowId = (index: number) => `${baseId}-row-${index}`;

  const open = (index: number) => {
    const row = rows[index];
    if (row?.kind !== 'file') return;
    const near = (step: 1 | -1): DiffTarget | null => {
      for (let j = index + step; j >= 0 && j < rows.length; j += step) {
        const r = rows[j];
        if (r.kind === 'file') return r.target;
      }
      return null;
    };
    openFile(row.target, [near(-1), near(1)].filter((t): t is DiffTarget => t !== null));
  };
  // Puts the cursor on `row`; a file row opens, so the cursor belongs to its diff.
  const place = (row: FileRow) => setCursor({ id: row.id, diffKey: row.kind === 'file' ? row.target.key : openKey });
  const moveTo = (index: number) => {
    const j = Math.max(0, Math.min(rows.length - 1, index));
    const row = rows[j];
    if (!row) return;
    place(row);
    v.scrollToIndex(j, { align: 'auto' });
    open(j);
  };
  const toggle = (path: string, expand?: boolean) =>
    setCollapsed((c) => {
      const next = new Set(c);
      if (expand ?? next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.ctrlKey || e.altKey || e.metaKey) return;
    const i = activeIndex;
    const row = rows[i];
    const page = Math.max(1, Math.floor((scrollRef.current?.clientHeight ?? 240) / FILE_ROW_H) - 1);
    switch (e.key) {
      case 'ArrowDown': moveTo(i + 1); break;
      case 'ArrowUp': moveTo(i < 0 ? 0 : i - 1); break;
      case 'PageDown': moveTo(i + page); break;
      case 'PageUp': moveTo(i - page); break;
      case 'Home': moveTo(0); break;
      case 'End': moveTo(rows.length - 1); break;
      case 'ArrowLeft':
        if (row?.kind === 'folder' && row.expanded) {
          place(row);
          toggle(row.path, false);
        } else if (!diffOpen) setFocus('graph');
        break;
      case 'ArrowRight':
        if (row?.kind === 'folder' && !row.expanded) {
          place(row);
          toggle(row.path, true);
        } else if (diffOpen) setFocus('diff');
        break;
      default:
        return;
    }
    e.preventDefault();
  };

  const countText = ([[counts.modified, 'modified'], [counts.added, 'added'], [counts.deleted, 'deleted'], [counts.renamed, 'renamed']] as const)
    .filter(([n]) => n > 0)
    .map(([n, l]) => `${n} ${l}`)
    .join(' · ');

  return (
    <div className="file-list">
      <div className="file-list-header">
        <span className="file-counts" data-testid="file-counts">{countText || 'No changes'}</span>
        <span className="file-totals" data-testid="file-totals"><span className="added">+{list.added}</span> <span className="deleted">−{list.deleted}</span></span>
      </div>
      <div className="file-toolbar" role="toolbar" aria-label="File list options">
        <div className="segmented">
          <button type="button" aria-pressed={mode === 'path'} onClick={() => setPrefs({ mode: 'path' })}>Path</button>
          <button type="button" aria-pressed={mode === 'tree'} onClick={() => setPrefs({ mode: 'tree' })}>Tree</button>
        </div>
        {allFilesCommit && <button type="button" aria-pressed={allFiles} onClick={() => setPrefs({ allFiles: !allFiles })}>View all files</button>}
        {mode === 'path' && <button type="button" aria-pressed={sort === 'status'} title="Sort by status, then path" onClick={() => setPrefs({ sort: sort === 'status' ? 'path' : 'status' })}>Sort by status</button>}
        {mode === 'tree' && (
          <>
            <button type="button" onClick={() => setCollapsed(new Set())}>Expand all</button>
            <button type="button" onClick={() => setCollapsed(new Set(allFolderPaths(list.files, unchanged)))}>Collapse all</button>
          </>
        )}
      </div>
      {tree.error && (
        <div className="file-list-error">
          <span role="alert">Couldn't list all files: {tree.error}</span>
          <button type="button" className="inline-retry" onClick={tree.retry}>Retry</button>
        </div>
      )}
      <div
        ref={scrollRef}
        className="file-list-scroll"
        role="listbox"
        aria-label={label}
        aria-activedescendant={activeIndex >= 0 && items.some((it) => it.index === activeIndex) ? rowId(activeIndex) : undefined}
        data-open-file={own || undefined}
        data-empty={rows.length === 0 || undefined}
        tabIndex={0}
        onKeyDown={onKeyDown}
      >
        <div style={{ height: v.getTotalSize(), position: 'relative' }}>
          {items.map((item) => {
            const row = rows[item.index];
            return (
              <Row
                key={row.id}
                id={rowId(item.index)}
                row={row}
                mode={mode}
                active={row.id === activeId}
                top={item.start}
                onMouseDown={(e) => {
                  if (e.button !== 0) return;
                  place(row);
                  if (row.kind === 'folder') toggle(row.path);
                  else open(item.index);
                }}
              />
            );
          })}
        </div>
      </div>
    </div>
  );
}
