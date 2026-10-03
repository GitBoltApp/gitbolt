import { stashLabel } from '../sidebar/stashLabel';
import { useVirtualizer } from '@tanstack/react-virtual';
import { Clock, GitBranch, GitGraph, MessageSquare, User } from 'lucide-react';
import { memo, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type HTMLAttributes, type KeyboardEvent, type MouseEvent, type RefObject } from 'react';
import type { CommitMessageCache } from '../api/commitMessages';
import type { CommitMessage } from '../api/gen/CommitMessage';
import type { GraphPayload } from '../api/gen/GraphPayload';
import type { RefLabel } from '../api/gen/RefLabel';
import type { RowPayload } from '../api/gen/RowPayload';
import { copyText } from '../api/transport';
import type { DateFormat } from '../api/gen/DateFormat';
import { useAppState } from '../app/state';
import { formatDate } from '../format/date';
import { Avatar } from '../avatars/Avatar';
import { avatars } from '../avatars/avatarStore';
import { buildMenu } from '../menu/registry';
import { openContextMenu, openMenuAt, type MenuEventLike } from '../menu/menuStore';
import { useContextTarget } from '../menu/contextTarget';
import { isEditableTarget } from '../ui/keys';
import { HoverTooltip, useHoverTooltip } from '../ui/HoverTooltip';
import { useToast } from '../ui/toast';
import { ColumnResizer } from './ColumnResizer';
import './columnMenu';
import type { ColumnTarget } from './columnMenu';
import { allocateColumns, autoGraphWidth, handleShown, isCollapsed, lanesWidth, useColumnPrefs, type ColumnWidths, type HideableColumn } from './columns';
import { graphLayout, LINE_W } from './draw';
import { GraphCanvas } from './GraphCanvas';
import { HeaderCell } from './HeaderCell';
import { PinButton } from './PinButton';
import { HScroll, HSCROLL_H } from './HScroll';
import { labelsByRowOf, membershipOf } from './graphIndex';
import { branchRows, type BranchMembership } from './membership';
import { anchoredScrollTop } from './anchor';
import { useGraphMetrics } from './metrics';
import { connectorLine, useDevicePixelRatio } from './pixels';
import { RefLabels } from './RefLabels';
import type { RowEditor } from './rowEditor';
import { WipSummary } from './WipSummary';
import { dimAllBut, ROW_DIM_CLASS, rowDimKindClass, strongerDim, useBranchFocus, type DimKind, type RowDim } from './rowDim';
import './graph.css';
import './extras.css';

/** The full commit message tooltip's rest delay: the one deliberately delayed tooltip (§8.4). */
export const MESSAGE_TOOLTIP_DELAY_MS = 500;

const renderMessage = (m: CommitMessage) => (
  <>
    <div className="msg-tooltip-summary">{m.summary}</div>
    {m.body && <div className="msg-tooltip-body">{m.body}</div>}
  </>
);

/**
 * The Message cell. Resting the pointer on it for MESSAGE_TOOLTIP_DELAY_MS shows the complete
 * message (summary plus full body, line breaks kept) in a tooltip just right of the cursor that
 * follows it. The tooltip never takes the pointer (`pointer-events: none`), so it's gone as soon
 * as the pointer leaves the cell, e.g. onto the next row (feedback F1). The graph payload
 * doesn't carry full bodies: the message is loaded on demand through `messages` (the per-repo
 * `commitMessage` cache the details panel shares), with "Loading…" if that takes over ~100 ms.
 * Pointer-only: the grid keeps focus on its scroll container (rows are never focused
 * themselves), and keyboard users read the selected commit's full message in the details panel
 * (§9.2).
 */
function MessageCell({ row, repoId, width, messages, dim }: { row: RowPayload; repoId: string; width: number; messages?: CommitMessageCache; dim: string }) {
  const isWip = row.kind === 'wip';
  const { triggerProps, tooltip } = useHoverTooltip({
    delayMs: MESSAGE_TOOLTIP_DELAY_MS,
    placement: 'pointer',
    disabled: isWip || !messages,
    className: 'msg-tooltip',
    content: () => {
      const cached = messages!.peek(row.id);
      return cached ? renderMessage(cached) : messages!.get(row.id).then(renderMessage);
    },
  });
  return (
    <span role="gridcell" data-col="message" className={`col-msg${dim}`} style={{ width }} {...triggerProps}>
      {isWip ? <WipSummary row={row} repoId={repoId} /> : <><span className="msg-summary">{row.kind === "stash" ? stashLabel(row.summary).text : row.summary}</span>{row.kind === "stash" && stashLabel(row.summary).branch && <span className="dim msg-body">{stashLabel(row.summary).branch}</span>}{row.bodyFirstLine && <span className="dim msg-body">{row.bodyFirstLine}</span>}</>}
      {tooltip}
    </span>
  );
}

const NO_LABELS: RefLabel[] = [];
const NO_ROWS: Set<number> = new Set();
/** Below this Graph column width the header pin button shows only its icon (the trunk name needs room beside the GRAPH title). */
const PIN_FULL_MIN = 130;
/** The `column` menu's toggle (stable: the store's action). */
const toggleHidden = (col: HideableColumn) => useColumnPrefs.getState().toggleHidden(col);

/** Rows either side of the screen whose avatars are also asked for, so normal scrolling doesn't
 * pop them in. Much smaller than the virtualizer's overscan: a fast scroll must stay cheap. */
export const AVATAR_OVERSCAN = 5;

/** Graph nodes draw from the shared avatar cache (keyed by email). Module-level, so stable. */
const avatarBitmap = (email: string) => avatars.get(email)?.bitmap ?? null;

/** Row-click modifiers (K27): `ctrl` (Ctrl or ⌘) toggles the row, `shift` selects a range. */
export type SelectMods = { ctrl: boolean; shift: boolean };

const PLAIN: SelectMods = { ctrl: false, shift: false };
const NO_SELECTED: ReadonlySet<number> = new Set();

/** In the Branch/Tag cell only the chips (the membership chip too, J6) and the +N badge select
 * the row: a press on the empty space around them or on the connector stops here instead of
 * reaching the row (F6). */
const onLabelsMouseDown = (e: MouseEvent<HTMLElement>) => {
  if (!(e.target instanceof Element && e.target.closest('.ref-label, .ref-more, .ref-stack'))) e.stopPropagation();
};

/** A row's DOM id (the keyboard commit-menu path, fix round 1, item 4: finding its element to
 * open the menu at, as `FileList.tsx`'s `rowId` does for its own rows). */
const graphRowId = (id: string) => `graph-row-${id}`;

/** The Author cell at its minimum (spec §8.4): the author's avatar alone, named by an instant
 * tooltip (and for assistive tech). It never asks for the image: the view's visible-rows request
 * (latest set wins on a fast scroll) already covers every commit row on screen. */
function AuthorAvatar({ name, email }: { name: string; email: string }) {
  const { triggerProps, tooltip } = useHoverTooltip({ content: name });
  return (
    <span className="author-avatar" role="img" aria-label={name} {...triggerProps}>
      <Avatar name={name} email={email} size={16} request={false} />
      {tooltip}
    </span>
  );
}

interface GraphRowProps {
  row: RowPayload;
  /** The Date column's preset (Settings > General). */
  dateFormat: DateFormat;
  /** The repo's key (stable): a WIP row's draft summary is stored under it. */
  repoId: string;
  index: number;
  start: number;
  /** The density's row height (H1). */
  rowH: number;
  /** The device pixel ratio (the app zoom included): the connector is snapped to it (K57). */
  dpr: number;
  /** Selected: the keyboard's row, or any other row of a compare or multi-selection (K27). */
  selected: boolean;
  cols: ColumnWidths;
  labels: RefLabel[];
  /** The branch this commit belongs to, while it's hovered or selected (F7); else null. */
  membership: BranchMembership | null;
  messages?: CommitMessageCache;
  onSelect(index: number, mods: SelectMods): void;
  onHover(id: string, index: number, inside: boolean): void;
  onCopySha(id: string): void;
  /** Its text cells are dimmed, and at which level (the row-dim mechanism, rowDim.ts); `false`
   * for not dimmed. */
  dimmed: DimKind | false;
  /** A branch chip on this row is entered (its refs) or left (null): J22's focus. */
  onBranchHover(refs: readonly string[] | null): void;
  /** A right-click anywhere on the row, or the keyboard (Shift+F10 / the ContextMenu key, on the
   * selected row — fix round 1, item 4, `FileList.tsx`'s own pattern): plan 1C Task 15's commit
   * menu. `MenuEventLike`, not a real `MouseEvent`, since the keyboard path has none. Omitted:
   * the native menu shows (no menu system installed yet). */
  onContextMenu?: (e: MenuEventLike, row: RowPayload) => void;
  /** A right-click on one of the row's branch/tag label chips (the commit or tag menu, with that
   * label's own target). */
  onLabelContextMenu?: (e: MouseEvent<HTMLElement>, row: RowPayload, label: RefLabel) => void;
  // --- 2C T9: double-clicks and the WIP row's menu ---
  /** A double-click on a label chip (a branch checks out, spec #2 §9.3) or on the row (another
   * worktree's WIP row becomes the active one, §11.2). */
  onLabelDoubleClick?: (row: RowPayload, label: RefLabel) => void;
  onRowDoubleClick?: (row: RowPayload) => void;
  /** A right-click on a WIP row (the `wip` menu kind). */
  onWipContextMenu?: (e: MenuEventLike, row: RowPayload) => void;
  // --- end 2C T9 ---
  /** HEAD's row only: the branch being rebased (2D T18). */
  rebasing?: string | null;
  /** A context menu is open for this row (a right-click on it or one of its chips): the
   * temporary "context" outline, which never changes the selection (UX round 2). */
  context?: boolean;
  /** This row's inline editor (rowEditor.ts), shown in its Branch/Tag cell over the chips. */
  editor?: RowEditor;
}

/** An inline editor's narrowest: room for a branch name even in a narrow Branch/Tag column (it
 * then floats over the graph column). */
const EDITOR_MIN_W = 200;

/**
 * One virtual row. Memoized: its props are all stable across scroll events (rows, memoized
 * widths, label lists and membership objects, stable callbacks), so scrolling re-renders only
 * the view and the canvas, not every row; a hover re-renders only the rows whose membership
 * chip appears or goes, and a branch focus (J22) only the rows whose `dimmed` changes.
 */
const GraphRow = memo(function GraphRow({ row, dateFormat, repoId, index, start, rowH, dpr, selected, cols, labels, membership, messages, onSelect, onHover, onCopySha, dimmed, onBranchHover, onContextMenu, onLabelContextMenu, onLabelDoubleClick, onRowDoubleClick, onWipContextMenu, rebasing = null, context = false, editor }: GraphRowProps) {
  const isWip = row.kind === 'wip';
  // A column at its minimum collapses its cells too (spec §8.4): icon-only chips, the avatar only.
  const authorAvatar = isCollapsed('author', cols.author);
  // The row-dim mechanism's classes, on the text cells only (never the chips or the graph): the
  // shared motion class plus the level's own colour class.
  const dim = dimmed ? ` ${ROW_DIM_CLASS} ${rowDimKindClass(dimmed)}` : '';
  // The chip-to-node connector's line, on the device pixel rows the canvas strokes it on (K57):
  // the checked-out branch's is a graph line (J21), 2 px.
  const line = labels.length > 0 ? connectorLine(start, rowH, labels[0].isHead ? LINE_W : 1, dpr) : null;
  return (
    <div
      id={graphRowId(row.id)}
      role="row"
      aria-rowindex={index + 1}
      aria-selected={selected}
      className={context ? 'graph-row is-context' : 'graph-row'}
      // `top`, not `transform: translateY`: a transform would make each row its own
      // stacking context and trap the hover-expanded label chip under the canvas.
      style={{ top: start, height: rowH }}
      // Only the primary button selects, with its modifiers (K27). A right-click opens the row's
      // menu without touching the selection or the details panel (UX round 2): the row shows the
      // `context` outline instead while its menu is open.
      onMouseDown={(e) => {
        if (e.button === 0) onSelect(index, { ctrl: e.ctrlKey || e.metaKey, shift: e.shiftKey });
      }}
      onMouseEnter={() => onHover(row.id, index, true)}
      onMouseLeave={() => onHover(row.id, index, false)}
      onContextMenu={(e) => (isWip ? onWipContextMenu : onContextMenu)?.(e, row)}
      onDoubleClick={onRowDoubleClick && (() => onRowDoubleClick(row))}
    >
      {/* A hidden column (spec §8.4) has width 0 and no cell. */}
      {cols.labels > 0 && (
        <span role="gridcell" data-col="labels" className="col-labels" style={{ width: cols.labels }} onMouseDown={onLabelsMouseDown}>
          {editor && (
            // Over the chips (which stay, so nothing moves), in the row's stacking context above the canvas.
            <span className="row-editor" style={{ width: Math.max(EDITOR_MIN_W, cols.labels - 8) }} onMouseDown={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()} onContextMenu={(e) => e.stopPropagation()}>
              {editor.render()}
            </span>
          )}
          <RefLabels
            labels={labels}
            color={row.color}
            membership={membership}
            onBranchHover={onBranchHover}
            compact={isCollapsed('labels', cols.labels)}
            width={cols.labels}
            line={line && { top: line.top - start, height: line.height }}
            rebasing={rebasing}
            sha={row.id}
            onContextMenu={onLabelContextMenu && ((label, e) => onLabelContextMenu(e, row, label))}
            onDoubleClick={onLabelDoubleClick && ((label) => onLabelDoubleClick(row, label))}
          />
        </span>
      )}
      <span role="gridcell" data-col="graph" style={{ width: cols.graph }} />
      <MessageCell row={row} repoId={repoId} width={isWip ? cols.message + cols.author + cols.date : cols.message} messages={messages} dim={dim} />
      {cols.author > 0 && !isWip && (
        <span role="gridcell" data-col="author" className={`col-author${authorAvatar ? ' col-author-avatar' : ''}${dim}`} style={{ width: cols.author }}>
          {authorAvatar ? <AuthorAvatar name={row.authorName} email={row.authorEmail} /> : row.authorName}
        </span>
      )}
      {cols.date > 0 && !isWip && <span role="gridcell" data-col="date" className={`col-date${dim}`} style={{ width: cols.date }}>{formatDate(row.committerTime, dateFormat)}</span>}
      {cols.sha > 0 && (
        <span role="gridcell" data-col="sha" className={`col-sha${dim}`} style={{ width: cols.sha }}>
          {!isWip && (
            <HoverTooltip content="Copy full SHA"><button type="button" data-testid="sha" className="sha" aria-description="Copy full SHA" onMouseDown={(e) => e.stopPropagation()} onClick={() => onCopySha(row.id)}>
              {/* The whole hash: the column shows as many whole characters as fit (graph.css). */}
              {row.id}
            </button></HoverTooltip>
          )}
        </span>
      )}
    </div>
  );
});

export interface GraphViewProps {
  graph: GraphPayload;
  /** A stable per-repo key (the repository's path) for per-repo view settings. */
  repoId: string;
  /**
   * The repo's full-message cache (`RepoServices.messages`), shared with the details panel, for
   * the full-message tooltip; without it there's no such tooltip. Keep it stable: every row
   * receives it, and rows are memoized.
   */
  messages?: CommitMessageCache;
  /** Controlled selection (plan 1B). Omitted: GraphView keeps its own, as in 1A. */
  selected?: number;
  /** Called on a click (`ctrl`: Ctrl or ⌘ held; `shift`: Shift held) or a keyboard move (Shift+↑/↓:
   * `shift`). Keep it stable (rows are memoized). */
  onSelect?: (index: number, mods: SelectMods) => void;
  /** More selected rows, shown like `selected`: a compare's or multi-selection's (spec §9.4,
   * K27). `selected` is the keyboard's position. Omitted: none. */
  alsoSelected?: ReadonlySet<number>;
  /** Keys GraphView doesn't handle itself (→, Enter, …). Return true if handled. */
  onUnhandledKey?: (key: string) => boolean;
  /** The grid element, for focus-zone registration. */
  gridRef?: RefObject<HTMLDivElement | null>;
  gridProps?: HTMLAttributes<HTMLDivElement>;
  /**
   * Rows whose text cells to dim, from outside (plan 1C Task 17's Ctrl+F:
   * `dimAllBut(matches, 'filter')`). Combined with the branch-hover focus (J22) row by row, at
   * the stronger level (`strongerDim`, rowDim.ts).
   */
  rowDim?: RowDim | null;
  /** Plan 1C Task 15's commit and label (branch/tag) context menus. Keep both stable (rows are
   * memoized). */
  onContextMenu?: (e: MenuEventLike, row: RowPayload) => void;
  onLabelContextMenu?: (e: MouseEvent<HTMLElement>, row: RowPayload, label: RefLabel) => void;
  // --- 2C T9 ---
  onLabelDoubleClick?: (row: RowPayload, label: RefLabel) => void;
  onRowDoubleClick?: (row: RowPayload) => void;
  onWipContextMenu?: (e: MenuEventLike, row: RowPayload) => void;
  // --- end 2C T9 ---
  /** The branch a rebase in the active worktree replays: drawn at HEAD's row (2D T18). */
  rebasing?: string | null;
  /** An inline editor open on one row (rowEditor.ts): GraphView only places it. */
  rowEditor?: RowEditor | null;
}

export function GraphView({ graph, repoId, messages, selected: controlled, alsoSelected = NO_SELECTED, onSelect, onUnhandledKey, gridRef, gridProps, rowDim = null, onContextMenu, onLabelContextMenu, onLabelDoubleClick, onRowDoubleClick, onWipContextMenu, rebasing = null, rowEditor = null }: GraphViewProps) {
  const dateFormat = useAppState((s) => s.settings.dateFormat);
  const ownRef = useRef<HTMLDivElement>(null);
  const scrollRef = gridRef ?? ownRef;
  // The last scroll offset while visible: restored when <Activity> shows the graph again
  // (spec §10.1). A hidden (display: none) element loses its scroll position.
  const lastScroll = useRef(0);
  const [scrollTop, setScrollTop] = useState(0);
  const [scrollLeft, setScrollLeft] = useState(0);
  const [viewportH, setViewportH] = useState(0);
  const [viewportW, setViewportW] = useState(0);
  const prefs = useColumnPrefs((s) => s.prefs);
  // The repo's hidden columns (spec §8.4), toggled from the header's `column` menu.
  const hidden = useColumnPrefs((s) => s.hidden);
  useLayoutEffect(() => useColumnPrefs.getState().loadFor(repoId), [repoId]);
  const [ownSelected, setOwnSelected] = useState(-1);
  const selected = controlled ?? ownSelected;
  const toast = useToast((s) => s.show);
  // The row a context menu is open for (its outline), and the menu handlers that mark it. Stable:
  // they reach the latest props through a ref, so the memoized rows keep the same callbacks.
  const [contextRow, openContextFor] = useContextTarget<string>();
  const menus = useRef({ onContextMenu, onLabelContextMenu, onWipContextMenu });
  menus.current = { onContextMenu, onLabelContextMenu, onWipContextMenu };
  const rowMenu = useCallback((e: MenuEventLike, row: RowPayload) => openContextFor(row.id, () => menus.current.onContextMenu?.(e, row)), [openContextFor]);
  const labelMenu = useCallback((e: MouseEvent<HTMLElement>, row: RowPayload, label: RefLabel) => openContextFor(row.id, () => menus.current.onLabelContextMenu?.(e, row, label)), [openContextFor]);
  const wipMenu = useCallback((e: MenuEventLike, row: RowPayload) => openContextFor(row.id, () => menus.current.onWipContextMenu?.(e, row)), [openContextFor]);
  // Display density (H1): row geometry for the rows, the virtualizer and the canvas. The cell
  // paddings and chip height are CSS variables on :root (theme/density.ts, read by graph.css).
  const metrics = useGraphMetrics();
  const dpr = useDevicePixelRatio();

  // Shared with the file menu (graphIndex.ts): computed once per payload.
  const labelsByRow = useMemo(() => labelsByRowOf(graph.labels), [graph.labels]);
  const labeledRows = useMemo(() => new Set(labelsByRow.keys()), [labelsByRow]);
  // The checked-out branch's row: HEAD's label sorts first on its row (J21).
  const headRow = useMemo(() => [...labelsByRow].find(([, ls]) => ls[0]?.isHead)?.[0] ?? -1, [labelsByRow]);
  // Once per graph (linear): the branch each non-tip commit belongs to (F7).
  const membership = useMemo(() => membershipOf(graph.rows, labelsByRow, graph.pinnedRef), [graph.rows, labelsByRow, graph.pinnedRef]);
  const membershipRef = useRef(membership);
  membershipRef.current = membership;
  // J22: a branch chip hovered for 500 ms dims the text of every row outside that branch (its
  // membership claims and tip), at the 'branch' level (the row-dim mechanism, rowDim.ts).
  const { refs: focusRefs, onBranchHover } = useBranchFocus();
  const hoverDim = useMemo(() => (focusRefs ? dimAllBut(branchRows(membership, labelsByRow, focusRefs), 'branch') : null), [focusRefs, membership, labelsByRow]);
  // Find's filter and the hover together: each row at the stronger level (rowDim.ts).
  const dim = useMemo(() => strongerDim(rowDim, hoverDim), [rowDim, hoverDim]);
  // The commit under the pointer is a ref: most crossings change nothing on screen. State holds
  // only the commit whose membership chip the hover shows, and is set only when that changes, so
  // crossing rows without a chip doesn't re-render the view at all. Keyed by commit id (not row
  // index), so a refresh that shifts the rows keeps the chip on the same commit.
  const pointerOn = useRef<string | null>(null);
  const hoverChipRef = useRef<string | null>(null);
  const [hoverChip, setHoverChip] = useState<string | null>(null);
  const hover = useCallback((id: string, index: number, inside: boolean) => {
    if (inside) pointerOn.current = id;
    else if (pointerOn.current === id) pointerOn.current = null;
    else return;
    const target = inside && membershipRef.current[index] ? id : null;
    if (target === hoverChipRef.current) return;
    hoverChipRef.current = target;
    setHoverChip(target);
  }, []);
  // Rendered column widths: the user's preferences, fitted to the scroll viewport's width
  // (columns.ts allocateColumns). Header cells, row cells and the canvas all read these.
  // Memoized so the (memoized) rows see the same object until a width actually changes.
  // The Graph column never gets wider than its lanes need (F2): the chosen width is kept, and
  // only clamped while it exceeds the current graph's max (a refresh or load more changes it).
  const graphMax = autoGraphWidth(graph.maxLanes, metrics);
  const graphW = Math.min(prefs.graph ?? graphMax, graphMax);
  const cols = useMemo(() => allocateColumns({ ...prefs, graph: graphW }, viewportW, hidden), [prefs, graphW, viewportW, hidden]);
  // Narrower than its lanes (F2): the collapse zone packs the lanes that don't fit (F11), and the
  // column gets its own lane scrollbar over the lane area, unless no lane fits at all (the strip).
  const lanesW = lanesWidth(graph.maxLanes, metrics);
  const clipped = cols.graph < lanesW;
  const layout = graphLayout(cols.graph, metrics, clipped);
  const laneScrollMax = clipped && !layout.strip ? Math.max(0, lanesW - layout.area) : 0;
  const [laneScroll, setLaneScroll] = useState(0);
  const canvasId = useId();
  const scrollX = Math.min(laneScroll, laneScrollMax);
  // Hidden Branch/Tag: no chips, so no connectors on the canvas either.
  const canvasLabeledRows = cols.labels > 0 ? labeledRows : NO_ROWS;
  const columnMenu = () => buildMenu<ColumnTarget, object>('column', { hidden, toggle: toggleHidden }, {});
  const onHeaderMenu = (e: MouseEvent) => openContextMenu(e, columnMenu);
  // The same menu from the keyboard (the menu key, Shift+F10), while a header control (a resize
  // handle) has focus: opened below that column's header cell.
  const onHeaderKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!(e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey)) || e.ctrlKey || e.altKey || e.metaKey) return;
    e.preventDefault();
    e.stopPropagation();
    const at = e.target instanceof Element ? e.target.closest('[data-col]') : null;
    openMenuAt(at ?? e.currentTarget, columnMenu());
  };

  const v = useVirtualizer({
    count: graph.rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => metrics.rowH,
    overscan: 20,
    initialRect: { width: 1200, height: 600 },
  });

  // A density change re-lays every row out at the new height, keeping the row at the top of the
  // viewport where it was.
  const laidOutRowH = useRef(metrics.rowH);
  useLayoutEffect(() => {
    const old = laidOutRowH.current;
    if (old === metrics.rowH) return;
    laidOutRowH.current = metrics.rowH;
    v.measure();
    const el = scrollRef.current;
    if (el) el.scrollTop = Math.round((el.scrollTop / old) * metrics.rowH);
  }, [metrics.rowH, v, scrollRef]);

  // A new avatar redraws the canvas only: rows don't take it as a prop, so memoized rows stay put.
  const avatarVersion = useSyncExternalStore(avatars.subscribe, avatars.version);
  // Ask for the avatars of the rows on screen plus AVATAR_OVERSCAN, latest set wins: a fast
  // scroll drops the queued requests of rows it went past. Re-asked on each arrival too, so an
  // image evicted while on screen comes back. Clamped: elastic overscroll (WebKit) gives a
  // negative scrollTop, and past the end.
  const firstVisible = Math.max(0, Math.floor(scrollTop / metrics.rowH) - AVATAR_OVERSCAN);
  const lastVisible = Math.min(graph.rows.length, Math.ceil((scrollTop + viewportH) / metrics.rowH) + AVATAR_OVERSCAN);
  useEffect(() => {
    const emails: string[] = [];
    for (let i = firstVisible; i < lastVisible; i++) {
      const r = graph.rows[i];
      if (r?.kind === 'commit') emails.push(r.authorEmail);
    }
    avatars.requestVisible(emails);
  }, [graph.rows, firstVisible, lastVisible, avatarVersion]);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const measure = () => {
      setViewportH(el.clientHeight);
      setViewportW(el.clientWidth);
    };
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    measure();
    return () => ro.disconnect();
  }, [scrollRef]);

  // Runs again each time <Activity> shows the graph (its effects are re-created), so returning
  // from a diff lands where the user left off.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && el.scrollTop !== lastScroll.current) el.scrollTop = lastScroll.current;
  }, [scrollRef]);

  const select = useCallback((i: number, mods: SelectMods = PLAIN) => {
    const clamped = Math.max(0, Math.min(graph.rows.length - 1, i));
    if (onSelect) onSelect(clamped, mods);
    else setOwnSelected(clamped);
    v.scrollToIndex(clamped, { align: 'auto' });
  }, [graph.rows.length, v, onSelect]);

  // The selection index last scrolled to. Before the refresh anchor below, which runs first: a
  // refresh moves the selected commit's index, and the selection effect must not scroll to it (K78).
  const shownSelection = useRef(selected);
  // A refresh (repo-changed / refs-updated, plan 1C) replaces the rows: what's on screen stays
  // where it was (spec §4.4 "keeps the selection and scroll position"). The selected commit is
  // the anchor while it's on screen, else the top row. The selection itself follows its commit
  // id (the store's `setGraph`; below for the uncontrolled one). Also runs when <Activity> shows
  // the graph again after a refresh while it was hidden, from the scroll the effect above
  // restored.
  const laidOut = useRef({ rows: graph.rows, selected });
  useLayoutEffect(() => {
    const prev = laidOut.current;
    const el = scrollRef.current;
    if (prev.rows === graph.rows || !el) return;
    const rowH = metrics.rowH;
    const top = el.scrollTop;
    const selId = prev.rows[prev.selected]?.id ?? null;
    const selOnScreen = selId !== null && (prev.selected + 1) * rowH > top && prev.selected * rowH < top + el.clientHeight;
    const anchorId = (selOnScreen ? selId : null) ?? prev.rows[Math.floor(top / rowH)]?.id ?? null;
    const next = anchoredScrollTop(prev.rows, graph.rows, anchorId, top, rowH);
    if (selId !== null) {
      const now = graph.rows.findIndex((r) => r.id === selId);
      if (controlled === undefined) {
        setOwnSelected(now);
        shownSelection.current = now;
      } else if (now === selected) {
        // The same commit, moved with the rows rather than from outside: no scroll to it.
        shownSelection.current = selected;
      }
    }
    if (next !== top) {
      el.scrollTop = next;
      lastScroll.current = next;
      // The canvas and the virtual window follow in this same frame, not on the scroll event.
      setScrollTop(next);
    }
  }, [graph.rows]); // eslint-disable-line react-hooks/exhaustive-deps
  // After the anchor: what the next refresh compares against (not while hidden, so a refresh
  // under a diff is anchored when the graph shows again).
  useLayoutEffect(() => {
    laidOut.current = { rows: graph.rows, selected };
  });

  // A controlled selection can also move from outside (a parent SHA in the details panel):
  // bring it into view. Only on an actual change, so re-showing the graph after a diff keeps the
  // restored scroll offset.
  // A layout effect: the scroll lands before the frame paints, so a jump (Find's next, held Enter)
  // moves the highlight and the viewport together.
  useLayoutEffect(() => {
    if (selected === shownSelection.current) return;
    shownSelection.current = selected;
    if (selected >= 0) v.scrollToIndex(selected, { align: 'auto' });
  }, [selected, v]);

  // The commit menu from the keyboard (the menu key, Shift+F10), at the selected row (fix round
  // 1, item 4; `FileList.tsx`'s own pattern). A `MenuEventLike`, not a real `MouseEvent`: there's
  // no click to build one from, so `openContextMenu` gets a small stand-in with the row's own
  // rect instead of a pointer position.
  const onGraphKeyDown = (e: KeyboardEvent) => {
    if (e.key !== 'ContextMenu' && !(e.key === 'F10' && e.shiftKey)) return false;
    const row = graph.rows[selected];
    const el = row ? document.getElementById(graphRowId(row.id)) : null;
    if (!row || !el || row.kind === 'wip' || !onContextMenu) return false;
    const r = el.getBoundingClientRect();
    rowMenu({ preventDefault() {}, stopPropagation() {}, clientX: r.left, clientY: r.bottom, timeStamp: performance.now() }, row);
    return true;
  };

  const onKeyDown = (e: KeyboardEvent) => {
    // A WIP row's draft box (K48) owns its keys; the grid's shortcuts never see them.
    if (isEditableTarget(e.target)) return;
    if (onGraphKeyDown(e)) {
      e.preventDefault();
      return;
    }
    const page = Math.max(1, Math.floor(viewportH / metrics.rowH) - 1);
    const moves: Record<string, number> = { ArrowDown: selected + 1, ArrowUp: selected - 1, PageDown: selected + page, PageUp: selected - page, Home: 0, End: graph.rows.length - 1 };
    if (e.key in moves) {
      // Shift+↑/↓ extend the range from the anchor (K27). With a diff open the change keys
      // (J14) take them first, app-wide, and the graph is hidden anyway.
      const shift = e.shiftKey && (e.key === 'ArrowDown' || e.key === 'ArrowUp');
      if (shift && e.defaultPrevented) return;
      e.preventDefault();
      select(moves[e.key], shift ? { ctrl: false, shift: true } : PLAIN);
    } else if (
      // Only keys aimed at the grid itself: Enter on a Tab-focused SHA button must still click
      // (copy), and keys typed in the portaled tooltip bubble here through React. Chords are
      // left for other bindings.
      e.target === e.currentTarget && !e.ctrlKey && !e.altKey && !e.metaKey && onUnhandledKey?.(e.key)
    ) e.preventDefault();
  };

  const copySha = useCallback((id: string) => {
    copyText(id).then(() => toast('Copied'), () => toast('Copy failed'));
  }, [toast]);

  return (
    <div className="graph-panel">
      {/* Outside the scroll container (so it stays put vertically), and translated by the
          table's scrollLeft so it tracks horizontal scrolling. */}
      {/* Right-click: the `column` menu, to hide or show columns (spec §8.4). */}
      <div className="graph-header" onContextMenu={onHeaderMenu} onKeyDown={onHeaderKeyDown}>
        <div className="graph-header-inner" style={{ width: cols.total, transform: `translateX(${-scrollLeft}px)` }}>
          {/* Every handle is on the right edge of the column it resizes (F3); SHA is last: none.
              A hidden column has no header cell, and a handle whose trade partner is hidden goes
              too (columns.ts handleShown). At its minimum a column's title is its icon (§8.4). */}
          {cols.labels > 0 && <span data-col="labels" style={{ width: cols.labels }}><HeaderCell col="labels" width={cols.labels} title="BRANCH / TAG" name="Branch / Tag" icon={GitBranch} /><ColumnResizer col="labels" name="Branch / Tag" cols={cols} available={viewportW} /></span>}
          <span data-col="graph" style={{ width: cols.graph }}><HeaderCell col="graph" width={cols.graph} title="GRAPH" name="Graph" icon={GitGraph} /><PinButton compact={cols.graph < PIN_FULL_MIN} /><ColumnResizer col="graph" name="Graph" cols={cols} available={viewportW} graphMax={graphMax} /></span>
          <span data-col="message" style={{ width: cols.message }}><HeaderCell col="message" width={cols.message} title="COMMIT MESSAGE" name="Commit message" icon={MessageSquare} />{handleShown('message', hidden) && <ColumnResizer col="message" name="Commit message" cols={cols} available={viewportW} />}</span>
          {cols.author > 0 && <span data-col="author" style={{ width: cols.author }}><HeaderCell col="author" width={cols.author} title="AUTHOR" name="Author" icon={User} />{handleShown('author', hidden) && <ColumnResizer col="author" name="Author" cols={cols} available={viewportW} />}</span>}
          {cols.date > 0 && <span data-col="date" style={{ width: cols.date }}><HeaderCell col="date" width={cols.date} title="COMMIT DATE / TIME" name="Commit date / time" icon={Clock} />{handleShown('date', hidden) && <ColumnResizer col="date" name="Date" cols={cols} available={viewportW} />}</span>}
          {cols.sha > 0 && <span data-col="sha" style={{ width: cols.sha }}><span className="col-title">SHA</span></span>}
        </div>
      </div>
      <div className="graph-body">
        <div {...gridProps} ref={scrollRef} className="graph-scroll" role="grid" aria-label="Commit graph" aria-rowcount={graph.rows.length} tabIndex={0} onKeyDown={onKeyDown} onScroll={(e) => {
          if (e.currentTarget.offsetParent !== null) lastScroll.current = e.currentTarget.scrollTop;
          setScrollTop(e.currentTarget.scrollTop);
          setScrollLeft(e.currentTarget.scrollLeft);
        }}>
          <div style={{ height: v.getTotalSize(), width: cols.total, position: 'relative' }}>
            {v.getVirtualItems().map((item) => {
              const row = graph.rows[item.index];
              const isSelected = item.index === selected || alsoSelected.has(item.index);
              return (
                <GraphRow
                  key={row.id}
                  row={row}
                  dateFormat={dateFormat}
                  repoId={repoId}
                  index={item.index}
                  start={item.start}
                  rowH={metrics.rowH}
                  dpr={dpr}
                  selected={isSelected}
                  cols={cols}
                  labels={labelsByRow.get(item.index) ?? NO_LABELS}
                  membership={row.id === hoverChip || isSelected ? membership[item.index] : null}
                  messages={messages}
                  onSelect={select}
                  onHover={hover}
                  onCopySha={copySha}
                  dimmed={dim?.dimmed(item.index) ?? false}
                  onBranchHover={onBranchHover}
                  onContextMenu={onContextMenu && rowMenu}
                  onLabelContextMenu={onLabelContextMenu && labelMenu}
                  onLabelDoubleClick={onLabelDoubleClick}
                  onRowDoubleClick={onRowDoubleClick}
                  onWipContextMenu={onWipContextMenu && wipMenu}
                  context={row.id === contextRow}
                  rebasing={rebasing && row.id === graph.head.target ? rebasing : null}
                  editor={rowEditor?.rowId === row.id ? rowEditor : undefined}
                />
              );
            })}
          </div>
        </div>
        {/* Clipped to the scroll viewport (clientWidth/clientHeight exclude the scrollbars), so a
            canvas that reaches past it never paints over the vertical scrollbar. */}
        <div className="graph-canvas-clip" style={{ width: viewportW, height: viewportH }}>
          <GraphCanvas rows={graph.rows} scrollTop={scrollTop} width={cols.graph} height={viewportH} left={cols.labels - scrollLeft} metrics={metrics} labeledRows={canvasLabeledRows} avatar={avatarBitmap} avatarVersion={avatarVersion} clipped={clipped} scrollX={scrollX} id={canvasId} selected={selected} alsoSelected={alsoSelected} headRow={headRow} />
        </div>
        {laneScrollMax > 0 && <HScroll left={cols.labels - scrollLeft} top={viewportH - HSCROLL_H} width={layout.area} contentW={lanesW} scrollX={scrollX} onScroll={setLaneScroll} controls={canvasId} />}
      </div>
    </div>
  );
}
