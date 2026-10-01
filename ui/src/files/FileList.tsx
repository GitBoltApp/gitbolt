import { useVirtualizer } from '@tanstack/react-virtual';
import { ChevronDown, ChevronRight, ChevronsDownUp, ChevronsUpDown, List, ListTree } from 'lucide-react';
import { Fragment, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react';
import { errorMessage } from '../api/client';
import type { DiffSpec } from '../api/gen/DiffSpec';
import type { FileChange } from '../api/gen/FileChange';
import type { FileListPayload } from '../api/gen/FileListPayload';
import { fileMenu, folderMenu, warmFileMenu } from '../menu/menuEnv';
import { openContextMenu, useMenu } from '../menu/menuStore';
import { filesKey } from '../repo/services';
import { useRepoView, useRepoViewStore, type DiffTarget } from '../repo/store';
import { DENSITY_METRICS, useDensity } from '../theme/density';
import { useHoverTooltip } from '../ui/HoverTooltip';
import { useFileListPrefs } from './fileListPrefs';
import { allFolderPaths, buildRows, countByStatus, matchesFilter, rowIndent, TREE, type FileListMode, type FileRow, type StatusCounts } from './fileTree';
import { FilesFilter } from './FilesFilter';
import { PathTooltip } from './RenamePaths';
import { StatusIcon } from './StatusIcon';
import './files.css';

/** A file-list row's height, CSS px: the density preset's (feedback H1; `--file-row-h` on :root
 * carries the same value). */
export const useFileRowH = () => useDensity((s) => DENSITY_METRICS[s.density].fileRowH);

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

/** `text`, with its first case-insensitive match of `query` wrapped for highlighting (feedback
 * K18: "if cheap" — one match, in the text actually shown; no cross-row or cross-segment work). */
function highlightMatch(text: string, query: string): ReactNode {
  if (!query) return text;
  const i = text.toLowerCase().indexOf(query);
  if (i === -1) return text;
  return (
    <Fragment>
      {text.slice(0, i)}
      <mark className="filter-match">{text.slice(i, i + query.length)}</mark>
      {text.slice(i + query.length)}
    </Fragment>
  );
}

const COUNT_KINDS = ['modified', 'added', 'deleted', 'renamed', 'conflicted'] as const;

/** "2 modified · 1 renamed": the non-zero counts, in the header's order. */
export const countsText = (c: StatusCounts, sep = ' · ') => COUNT_KINDS.filter((k) => c[k] > 0).map((k) => `${c[k]} ${k}`).join(sep);

/** Coloured status icons with their numbers, non-zero kinds only (feedback F19/F20). Named as
 * one image ("2 modified · 1 renamed"); the icons themselves are decorative. */
function StatusCountsView({ counts, testId, size }: { counts: StatusCounts; testId: string; size: number }) {
  const text = countsText(counts);
  if (!text) return null;
  return (
    <span className="status-counts" data-testid={testId} role="img" aria-label={text}>
      {COUNT_KINDS.filter((k) => counts[k] > 0).map((k) => (
        <span key={k} className="status-count"><StatusIcon status={k} size={size} decorative />{counts[k]}</span>
      ))}
    </span>
  );
}

interface RowProps { id: string; row: FileRow; mode: FileListMode; active: boolean; top: number; height: number; filterQuery: string; onMouseDown: (e: MouseEvent) => void; onContextMenu: (e: MouseEvent) => void }

/** The file list a row is in: its tooltip opens left of it, over the center panel, so it never
 * covers the rows above or below (feedback J18). */
const fileListOf = (row: HTMLElement) => row.closest('.file-list');

/** A folder row, or a file row with its full path in an instant hover tooltip, left of the list (a rename: old,
 * ↓, new; feedback H22). A renamed file shows its new name (tree) or new path (path view); the
 * old one is in the tooltip and the diff header. */
function Row({ id, row, mode, active, top, height, filterQuery, onMouseDown, onContextMenu }: RowProps) {
  const style = { top, height, paddingLeft: rowIndent(row.depth), gap: TREE.gap };
  const file = row.kind === 'file' ? row : null;
  const tip = useHoverTooltip({ content: file ? <PathTooltip path={file.target.path} oldPath={file.change?.oldPath ?? null} /> : null, disabled: !file, placement: 'left-of', leftOf: fileListOf });
  if (row.kind === 'folder') {
    return (
      <div id={id} role="option" aria-selected={active} aria-expanded={row.expanded} data-kind="folder" data-path={row.path} className="file-row" style={style} onMouseDown={onMouseDown} onContextMenu={onContextMenu}>
        <span className="file-chevron" style={{ width: TREE.chevron }}>{row.expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}</span>
        <span className="file-name">{highlightMatch(row.name, filterQuery)}</span>
        {row.counts && <StatusCountsView counts={row.counts} testId="folder-counts" size={10} />}
      </div>
    );
  }
  const c = row.change;
  const s = stats(c);
  return (
    <div
      id={id}
      role="option"
      aria-selected={active}
      data-kind="file"
      data-path={row.target.path}
      className={c ? 'file-row' : 'file-row unchanged'}
      style={style}
      onMouseDown={onMouseDown}
      onContextMenu={(e) => {
        tip.hide();
        onContextMenu(e);
      }}
      {...tip.triggerProps}
    >
      {c ? <StatusIcon status={c.status} size={TREE.icon} /> : <span className="status-spacer" style={{ width: TREE.icon }} aria-hidden="true" />}
      {mode === 'path' && row.dir && <span className="file-dir">{highlightMatch(row.dir, filterQuery)}/</span>}
      <span className="file-name">{highlightMatch(row.name, filterQuery)}</span>
      {s && (
        <span className="file-stats">
          {c?.additions === null ? 'binary' : <><span className="added">+{c?.additions}</span> <span className="deleted">−{c?.deletions}</span></>}
        </span>
      )}
      {tip.tooltip}
    </div>
  );
}

/**
 * The active row: the keyboard cursor while the diff it was set for is still open, else the
 * open file's row, else (its folder collapsed) the deepest visible folder holding it.
 */
function activeRowId(rows: FileRow[], cursor: Cursor | null, open: { key: string; path: string } | null, own: boolean, cursorHere: boolean): string | null {
  const openKey = open?.key ?? null;
  // With no diff open, only the list the cursor was last put in shows it (a WIP has two).
  if (cursor && cursor.diffKey === openKey && (openKey !== null || cursorHere) && rows.some((r) => r.id === cursor.id)) return cursor.id;
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
  const store = useRepoViewStore();
  const openFile = useRepoView((s) => s.openFile);
  const closeDiffTo = useRepoView((s) => s.closeDiffTo);
  const closeDiff = useRepoView((s) => s.closeDiff);
  const openKey = useRepoView((s) => s.diff?.key ?? null);
  const openPath = useRepoView((s) => s.diff?.path ?? null);
  const { mode, sort, allFiles, set: setPrefs } = useFileListPrefs();
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const [cursor, setCursor] = useState<Cursor | null>(null);
  // "View all files"' filter (feedback K18-K20): transient, never persisted, and only shown (or
  // applied) while View all files is on — cleared when it's turned off.
  const [filterText, setFilterText] = useState('');
  useEffect(() => { if (!allFiles) setFilterText(''); }, [allFiles]);
  const filterQuery = allFiles ? filterText.trim().toLowerCase() : '';
  // The file menu's openers and remotes, loaded ahead so it opens fully drawn (spec §7).
  const services = useRepoView((s) => s.services);
  const graph = useRepoView((s) => s.graph);
  useEffect(() => warmFileMenu(services, graph), [services, graph]);
  const tree = useTreePaths(allFiles ? allFilesCommit : null);
  const paths = tree.paths;
  const unchanged = useMemo(() => (allFiles && allFilesCommit && paths ? { commit: allFilesCommit, paths } : null), [allFiles, allFilesCommit, paths]);
  // The filter narrows both the changed and the unchanged files it's built from; a folder with no
  // surviving descendant just isn't in the tree `buildRows` builds from what's left.
  const filteredFiles = useMemo(() => (filterQuery ? list.files.filter((f) => matchesFilter(f.path, filterQuery)) : list.files), [list.files, filterQuery]);
  const filteredUnchanged = useMemo(() => {
    if (!unchanged) return null;
    if (!filterQuery) return unchanged;
    return { commit: unchanged.commit, paths: unchanged.paths.filter((p) => matchesFilter(p, filterQuery)) };
  }, [unchanged, filterQuery]);
  const rows = useMemo(() => buildRows({ files: filteredFiles, spec, unchanged: filteredUnchanged, mode, sort, collapsed }), [filteredFiles, spec, filteredUnchanged, mode, sort, collapsed]);
  // Every target key of this list starts with its spec's key (`targetFor`, `fileViewTarget`).
  const own = openKey !== null && openKey.startsWith(`${filesKey(spec)}|`);
  const cursorHere = useRepoView((s) => s.fileListCursor === filesKey(spec));
  const setFileListCursor = useRepoView((s) => s.setFileListCursor);
  const activeId = activeRowId(rows, cursor, openKey !== null && openPath !== null ? { key: openKey, path: openPath } : null, own, cursorHere);
  const scrollRef = useRef<HTMLDivElement>(null);
  const baseId = useId();
  const rowH = useFileRowH();
  const v = useVirtualizer({ count: rows.length, getScrollElement: () => scrollRef.current, estimateSize: () => rowH, overscan: 12, initialRect: { width: 400, height: 400 } });
  // A density change re-lays the rows out at the new height.
  const laidOutRowH = useRef(rowH);
  useLayoutEffect(() => {
    if (laidOutRowH.current === rowH) return;
    laidOutRowH.current = rowH;
    v.measure();
  }, [rowH, v]);
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
  const place = (row: FileRow) => {
    setCursor({ id: row.id, diffKey: row.kind === 'file' ? row.target.key : openKey });
    setFileListCursor(filesKey(spec));
  };
  /** The first file row from `from` (inclusive) stepping by `step`; failing that, by `fallback`
   * from the same place. -1 when there's none. */
  const fileAt = (from: number, step: 1 | -1, fallback?: 1 | -1): number => {
    for (let j = from; j >= 0 && j < rows.length; j += step) if (rows[j].kind === 'file') return j;
    return fallback ? fileAt(from, fallback) : -1;
  };
  /** `j`, or `wrap()`'s result when `j` is -1 (feedback K4: ↑/↓ wrap at the list's ends). */
  const orWrap = (j: number, wrap: () => number): number => (j === -1 ? wrap() : j);
  /** Puts the cursor on file row `j`, scrolls to it and opens it; nothing if there's none, or
   * it's the open file already. */
  const moveToFile = (j: number) => {
    const row = rows[j];
    if (row?.kind !== 'file' || (j === activeIndex && row.target.key === openKey)) return;
    place(row);
    v.scrollToIndex(j, { align: 'auto' });
    open(j);
  };
  /** The first file row with changes from `from` (inclusive) stepping by `step`. -1 when there's
   * none (feedback K19: "Previous/Next changed file" skips unchanged rows). */
  const changedFileAt = (from: number, step: 1 | -1): number => {
    for (let j = from; j >= 0 && j < rows.length; j += step) {
      const r = rows[j];
      if (r.kind === 'file' && r.change !== null) return j;
    }
    return -1;
  };
  /** "Previous changed file" / "Next changed file" (K19): from the active row, or an end when
   * there's none; wraps around. */
  const jumpChanged = (step: 1 | -1) => {
    const from = activeIndex >= 0 ? activeIndex + step : (step === 1 ? 0 : rows.length - 1);
    moveToFile(orWrap(changedFileAt(from, step), () => changedFileAt(step === 1 ? 0 : rows.length - 1, step)));
  };
  // Feedback K20: clearing the filter re-centres the selected row, once the wider, unfiltered
  // rows it scrolls against are the ones laid out (the effect below, keyed on `rows`/`activeIndex`
  // so it fires after that recompute, not on the click itself).
  const centerOnClear = useRef(false);
  const clearFilter = () => {
    centerOnClear.current = true;
    setFilterText('');
  };
  useLayoutEffect(() => {
    if (!centerOnClear.current) return;
    centerOnClear.current = false;
    if (activeIndex >= 0) v.scrollToIndex(activeIndex, { align: 'center' });
  }, [rows, activeIndex, v]);
  // Feedback H5b: the open file's row closes it (a toggle). The row keeps the cursor, with no
  // diff, so Enter/Space opens it again; the keyboard stays in the list.
  const toggleFile = (row: Extract<FileRow, { kind: 'file' }>, index: number) => {
    if (row.target.key === openKey) {
      setCursor({ id: row.id, diffKey: null });
      setFileListCursor(filesKey(spec));
      closeDiffTo('files');
    } else {
      place(row);
      open(index);
    }
  };
  // The file or folder menu (spec §7) for `row`. A folder's Open in ▸ Files opens a path in it:
  // its first file listed.
  const menuFor = (row: FileRow) => {
    if (row.kind === 'file') return fileMenu(store, spec, row.target, row.change !== null);
    const inside = `${row.path}/`;
    const child = list.files.find((f) => f.path.startsWith(inside))?.path ?? unchanged?.paths.find((p) => p.startsWith(inside)) ?? `${inside}${row.name}`;
    return folderMenu(store, spec, row.path, child);
  };
  // From the keyboard, at `at`; timed from the key, before the rows are built.
  const showMenu = (row: FileRow, at: { x: number; y: number }) => {
    const t0 = performance.now();
    const build = menuFor(row);
    useMenu.getState().show(build(), at.x, at.y, t0, build);
  };
  const toggle = (path: string, expand?: boolean) =>
    setCollapsed((c) => {
      const next = new Set(c);
      if (expand ?? next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  const onKeyDown = (e: KeyboardEvent) => {
    // A stale list (the next selection is loading, feedback F12) opens nothing.
    if (e.ctrlKey || e.altKey || e.metaKey || store.getState().panelPending) return;
    const i = activeIndex;
    const row = rows[i];
    // The context menu from the keyboard (the menu key, Shift+F10), at the active file's row.
    if (e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey)) {
      const el = row ? document.getElementById(rowId(i)) : null;
      if (row && el) {
        const r = el.getBoundingClientRect();
        showMenu(row, { x: r.left + rowIndent(row.depth), y: r.bottom });
        e.preventDefault();
      }
      return;
    }
    const page = Math.max(1, Math.floor((scrollRef.current?.clientHeight ?? 240) / rowH) - 1);
    const last = rows.length - 1;
    // Feedback J3: the moves land on file rows only (folder rows are skipped), and open them.
    // Feedback K4: ↓ past the last file wraps to the first, ↑ past the first wraps to the last.
    switch (e.key) {
      case 'ArrowDown': moveToFile(i < 0 ? fileAt(0, 1) : orWrap(fileAt(i + 1, 1), () => fileAt(0, 1))); break;
      case 'ArrowUp': moveToFile(i < 0 ? fileAt(0, 1) : orWrap(fileAt(i - 1, -1), () => fileAt(last, -1))); break;
      case 'PageDown': { const t = Math.min(last, i + page); moveToFile(fileAt(t, 1, -1)); break; }
      case 'PageUp': { const t = Math.max(0, i - page); moveToFile(fileAt(t, -1, 1)); break; }
      case 'Home': moveToFile(fileAt(0, 1)); break;
      case 'End': moveToFile(fileAt(last, -1)); break;
      // Feedback J2: ← collapses an expanded folder; anywhere else it closes the diff and goes
      // back to the graph (the selection stays). → expands a collapsed folder, moves into an
      // expanded one (its first child), or opens the file (nothing if it's already open).
      case 'ArrowLeft':
        if (row?.kind === 'folder' && row.expanded) {
          place(row);
          toggle(row.path, false);
        } else closeDiff();
        break;
      case 'ArrowRight':
        if (row?.kind === 'folder' && !row.expanded) {
          place(row);
          toggle(row.path, true);
        } else if (row?.kind === 'folder') {
          // Expanded: on to its first child (a file opens, as every move onto one does).
          const child = rows[i + 1];
          if (child?.kind === 'file' && child.depth > row.depth) moveToFile(i + 1);
          else if (child && child.depth > row.depth) {
            place(child);
            v.scrollToIndex(i + 1, { align: 'auto' });
          }
        } else if (row?.kind === 'file' && row.target.key !== openKey) toggleFile(row, i);
        break;
      case 'Enter':
      case ' ':
        if (row?.kind === 'folder') {
          place(row);
          toggle(row.path);
        } else if (row?.kind === 'file') toggleFile(row, i);
        break;
      default:
        return;
    }
    e.preventDefault();
  };

  const folders = useMemo(() => (mode === 'tree' ? allFolderPaths(filteredFiles, filteredUnchanged) : []), [mode, filteredFiles, filteredUnchanged]);
  const allExpanded = folders.every((p) => !collapsed.has(p));
  const hasChangedRow = useMemo(() => rows.some((r) => r.kind === 'file' && r.change !== null), [rows]);

  return (
    <div className="file-list">
      <div className="file-list-header">
        {countsText(counts) ? <StatusCountsView counts={counts} testId="file-counts" size={12} /> : <span className="file-counts" data-testid="file-counts">No changes</span>}
        <span className="file-totals" data-testid="file-totals"><span className="added">+{list.added}</span> <span className="deleted">−{list.deleted}</span></span>
      </div>
      {/* Justified: the mode's action on the left, Path/Tree in the centre, View all files on
          the right (feedback F18). */}
      <div className="file-toolbar" role="toolbar" aria-label="File list options">
        <div className="file-toolbar-start">
          {mode === 'tree' ? (
            // One smart button: expands everything unless everything already is (then collapses).
            // `icon-lead` (feedback H17): the chevrons' ink starts ~3 px into their box, so the
            // left padding is trimmed to match the text's right padding.
            <button type="button" className="toolbar-button icon-lead" disabled={folders.length === 0} onClick={() => setCollapsed(allExpanded ? new Set(folders) : new Set())}>
              {allExpanded ? <ChevronsDownUp size={12} aria-hidden /> : <ChevronsUpDown size={12} aria-hidden />}
              {allExpanded ? 'Collapse all' : 'Expand all'}
            </button>
          ) : (
            <button type="button" className="toolbar-button" aria-pressed={sort === 'status'} title="Sort by status, then path" onClick={() => setPrefs({ sort: sort === 'status' ? 'path' : 'status' })}>Sort by status</button>
          )}
        </div>
        <div className="file-toolbar-center">
          <div className="segmented">
            <button type="button" aria-pressed={mode === 'path'} onClick={() => setPrefs({ mode: 'path' })}><List size={12} aria-hidden />Path</button>
            <button type="button" aria-pressed={mode === 'tree'} onClick={() => setPrefs({ mode: 'tree' })}><ListTree size={12} aria-hidden />Tree</button>
          </div>
        </div>
        <div className="file-toolbar-end">
          {allFilesCommit && <button type="button" className="toolbar-button" aria-pressed={allFiles} onClick={() => setPrefs({ allFiles: !allFiles })}>View all files</button>}
        </div>
      </div>
      {allFiles && (
        <FilesFilter
          value={filterText}
          onChange={setFilterText}
          onClear={clearFilter}
          onPrev={() => jumpChanged(-1)}
          onNext={() => jumpChanged(1)}
          canStep={hasChangedRow}
          onEmptyEscape={closeDiff}
        />
      )}
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
                height={rowH}
                filterQuery={filterQuery}
                onMouseDown={(e) => {
                  // Every press toggles (K2, K3), the second of a quick pair too: the browser counts
                  // it as a double-click (`detail` 2), but to the user it's just another click.
                  if (e.button !== 0) return;
                  if (row.kind === 'file') return toggleFile(row, item.index);
                  place(row);
                  toggle(row.path);
                }}
                onContextMenu={(e) => openContextMenu(e, menuFor(row))}
              />
            );
          })}
        </div>
      </div>
    </div>
  );
}
