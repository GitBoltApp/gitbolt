import { useVirtualizer } from '@tanstack/react-virtual';
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type HTMLAttributes, type KeyboardEvent, type MouseEvent, type RefObject } from 'react';
import type { CommitMessageCache } from '../api/commitMessages';
import type { CommitMessage } from '../api/gen/CommitMessage';
import type { GraphPayload } from '../api/gen/GraphPayload';
import type { RefLabel } from '../api/gen/RefLabel';
import type { RowPayload } from '../api/gen/RowPayload';
import { copyText } from '../api/transport';
import { formatDate } from '../format/date';
import { wipCountsText } from '../format/wip';
import { avatars } from '../avatars/avatarStore';
import type { CompareMarks } from '../repo/store';
import { useHoverTooltip } from '../ui/HoverTooltip';
import { useToast } from '../ui/toast';
import { ColumnResizer } from './ColumnResizer';
import { allocateColumns, autoGraphWidth, lanesWidth, useColumnPrefs, type ColumnWidths } from './columns';
import { GraphCanvas } from './GraphCanvas';
import { branchMembership, labelsByRow as groupLabels, type BranchMembership } from './membership';
import { useGraphMetrics } from './metrics';
import { RefLabels } from './RefLabels';
import './graph.css';

function WipSummary({ row }: { row: RowPayload }) {
  const w = row.wip!;
  return (
    <>
      <span className="wip-tag">// WIP</span>
      {w.worktreeName && <span className="dim"> {w.worktreeName}</span>}
      <span className="wip-counts"> {wipCountsText(w)}</span>
    </>
  );
}

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
function MessageCell({ row, width, messages, mark }: { row: RowPayload; width: number; messages?: CommitMessageCache; mark: 'A' | 'B' | null }) {
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
    <span role="gridcell" data-col="message" className="col-msg" style={{ width }} {...triggerProps}>
      {mark && <span className="compare-marker" role="img" aria-label={`Compare ${mark}`} data-testid={mark === 'A' ? 'compare-a' : 'compare-b'}>{mark}</span>}
      {isWip ? <WipSummary row={row} /> : <><span className="msg-summary">{row.summary}</span>{row.bodyFirstLine && <span className="dim msg-body">{row.bodyFirstLine}</span>}</>}
      {tooltip}
    </span>
  );
}

const NO_LABELS: RefLabel[] = [];

/** Rows either side of the screen whose avatars are also asked for, so normal scrolling doesn't
 * pop them in. Much smaller than the virtualizer's overscan: a fast scroll must stay cheap. */
export const AVATAR_OVERSCAN = 5;

/** Graph nodes draw from the shared avatar cache (keyed by email). Module-level, so stable. */
const avatarBitmap = (email: string) => avatars.get(email)?.bitmap ?? null;

export type SelectMods = { ctrl: boolean };

/** In the Branch/Tag cell only the chips (and the +N badge) select the row: a press on the empty
 * space around them, on the connector or on the inert membership chip (F7) stops here instead of
 * reaching the row (F6). */
const onLabelsMouseDown = (e: MouseEvent<HTMLElement>) => {
  if (!(e.target instanceof Element && e.target.closest('.ref-label:not(.ref-label-dim), .ref-more'))) e.stopPropagation();
};

interface GraphRowProps {
  row: RowPayload;
  index: number;
  start: number;
  /** The density's row height (H1). */
  rowH: number;
  selected: boolean;
  /** The row's compare badge (spec §9.4), if it is a compare endpoint. */
  mark: 'A' | 'B' | null;
  cols: ColumnWidths;
  labels: RefLabel[];
  /** The branch this commit belongs to, while it's hovered or selected (F7); else null. */
  membership: BranchMembership | null;
  messages?: CommitMessageCache;
  onSelect(index: number, mods: SelectMods): void;
  onHover(id: string, index: number, inside: boolean): void;
  onCopySha(id: string): void;
}

/**
 * One virtual row. Memoized: its props are all stable across scroll events (rows, memoized
 * widths, label lists and membership objects, stable callbacks), so scrolling re-renders only
 * the view and the canvas, not every row; a hover re-renders only the rows whose membership
 * chip appears or goes.
 */
const GraphRow = memo(function GraphRow({ row, index, start, rowH, selected, mark, cols, labels, membership, messages, onSelect, onHover, onCopySha }: GraphRowProps) {
  const isWip = row.kind === 'wip';
  return (
    <div
      role="row"
      aria-rowindex={index + 1}
      aria-selected={selected}
      className="graph-row"
      // `top`, not `transform: translateY`: a transform would make each row its own
      // stacking context and trap the hover-expanded label chip under the canvas.
      style={{ top: start, height: rowH }}
      onMouseDown={(e) => onSelect(index, { ctrl: e.ctrlKey || e.metaKey })}
      onMouseEnter={() => onHover(row.id, index, true)}
      onMouseLeave={() => onHover(row.id, index, false)}
    >
      <span role="gridcell" data-col="labels" className="col-labels" style={{ width: cols.labels }} onMouseDown={onLabelsMouseDown}>
        <RefLabels labels={labels} color={row.color} membership={membership} />
      </span>
      <span role="gridcell" data-col="graph" style={{ width: cols.graph }} />
      <MessageCell row={row} width={cols.message} messages={messages} mark={mark} />
      <span role="gridcell" data-col="author" className="col-author" style={{ width: cols.author }}>{row.authorName}</span>
      <span role="gridcell" data-col="date" className="col-date" style={{ width: cols.date }}>{isWip ? '' : formatDate(row.committerTime)}</span>
      <span role="gridcell" data-col="sha" className="col-sha" style={{ width: cols.sha }}>
        {!isWip && (
          <button type="button" data-testid="sha" className="sha" title="Copy full SHA" onMouseDown={(e) => e.stopPropagation()} onClick={() => onCopySha(row.id)}>
            {/* The whole hash: the column shows as many whole characters as fit (graph.css). */}
            {row.id}
          </button>
        )}
      </span>
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
  /** Called on a click (`ctrl`: Ctrl or ⌘ held) or a keyboard move. Keep it stable (rows are memoized). */
  onSelect?: (index: number, mods: SelectMods) => void;
  /** Compare endpoints, drawn as A/B badges (spec §9.4). */
  compare?: CompareMarks;
  /** Keys GraphView doesn't handle itself (→, Enter, …). Return true if handled. */
  onUnhandledKey?: (key: string) => boolean;
  /** The grid element, for focus-zone registration. */
  gridRef?: RefObject<HTMLDivElement | null>;
  gridProps?: HTMLAttributes<HTMLDivElement>;
}

export function GraphView({ graph, repoId, messages, selected: controlled, onSelect, compare, onUnhandledKey, gridRef, gridProps }: GraphViewProps) {
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
  useLayoutEffect(() => useColumnPrefs.getState().loadFor(repoId), [repoId]);
  const [ownSelected, setOwnSelected] = useState(-1);
  const selected = controlled ?? ownSelected;
  const toast = useToast((s) => s.show);
  // Display density (H1): row geometry for the rows, the virtualizer and the canvas. The cell
  // paddings and chip height are CSS variables on :root (theme/density.ts, read by graph.css).
  const metrics = useGraphMetrics();

  const labelsByRow = useMemo(() => groupLabels(graph.labels), [graph.labels]);
  const labeledRows = useMemo(() => new Set(labelsByRow.keys()), [labelsByRow]);
  // Once per graph (linear): the branch each non-tip commit belongs to (F7).
  const membership = useMemo(() => branchMembership(graph.rows, labelsByRow, graph.pinnedRef), [graph.rows, labelsByRow, graph.pinnedRef]);
  const membershipRef = useRef(membership);
  membershipRef.current = membership;
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
  const cols = useMemo(() => allocateColumns({ ...prefs, graph: graphW }, viewportW), [prefs, graphW, viewportW]);

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

  const select = useCallback((i: number, mods: SelectMods = { ctrl: false }) => {
    const clamped = Math.max(0, Math.min(graph.rows.length - 1, i));
    if (onSelect) onSelect(clamped, mods);
    else setOwnSelected(clamped);
    v.scrollToIndex(clamped, { align: 'auto' });
  }, [graph.rows.length, v, onSelect]);

  // A controlled selection can also move from outside (a parent SHA in the details panel):
  // bring it into view. Only on an actual change, so re-showing the graph after a diff keeps the
  // restored scroll offset.
  const shownSelection = useRef(selected);
  useEffect(() => {
    if (selected === shownSelection.current) return;
    shownSelection.current = selected;
    if (selected >= 0) v.scrollToIndex(selected, { align: 'auto' });
  }, [selected, v]);

  const onKeyDown = (e: KeyboardEvent) => {
    const page = Math.max(1, Math.floor(viewportH / metrics.rowH) - 1);
    const moves: Record<string, number> = { ArrowDown: selected + 1, ArrowUp: selected - 1, PageDown: selected + page, PageUp: selected - page, Home: 0, End: graph.rows.length - 1 };
    if (e.key in moves) {
      e.preventDefault();
      select(moves[e.key]);
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
      <div className="graph-header">
        <div className="graph-header-inner" style={{ width: cols.total, transform: `translateX(${-scrollLeft}px)` }}>
          {/* Every handle is on the right edge of the column it resizes (F3); SHA is last: none. */}
          <span data-col="labels" style={{ width: cols.labels }}><span className="col-title">BRANCH / TAG</span><ColumnResizer col="labels" name="Branch / Tag" cols={cols} available={viewportW} /></span>
          <span data-col="graph" style={{ width: cols.graph }}><span className="col-title">GRAPH</span><ColumnResizer col="graph" name="Graph" cols={cols} available={viewportW} graphMax={graphMax} /></span>
          <span data-col="message" style={{ width: cols.message }}><span className="col-title">COMMIT MESSAGE</span><ColumnResizer col="message" name="Commit message" cols={cols} available={viewportW} /></span>
          <span data-col="author" style={{ width: cols.author }}><span className="col-title">AUTHOR</span><ColumnResizer col="author" name="Author" cols={cols} available={viewportW} /></span>
          <span data-col="date" style={{ width: cols.date }}><span className="col-title">COMMIT DATE / TIME</span><ColumnResizer col="date" name="Date" cols={cols} available={viewportW} /></span>
          <span data-col="sha" style={{ width: cols.sha }}><span className="col-title">SHA</span></span>
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
              return (
                <GraphRow
                  key={row.id}
                  row={row}
                  index={item.index}
                  start={item.start}
                  rowH={metrics.rowH}
                  selected={item.index === selected}
                  mark={compare?.a === item.index ? 'A' : compare?.b === item.index ? 'B' : null}
                  cols={cols}
                  labels={labelsByRow.get(item.index) ?? NO_LABELS}
                  membership={row.id === hoverChip || item.index === selected ? membership[item.index] : null}
                  messages={messages}
                  onSelect={select}
                  onHover={hover}
                  onCopySha={copySha}
                />
              );
            })}
          </div>
        </div>
        {/* Clipped to the scroll viewport (clientWidth/clientHeight exclude the scrollbars), so a
            canvas that reaches past it never paints over the vertical scrollbar. */}
        <div className="graph-canvas-clip" style={{ width: viewportW, height: viewportH }}>
          <GraphCanvas rows={graph.rows} scrollTop={scrollTop} width={cols.graph} height={viewportH} left={cols.labels - scrollLeft} metrics={metrics} labeledRows={labeledRows} avatar={avatarBitmap} avatarVersion={avatarVersion} clipped={cols.graph < lanesWidth(graph.maxLanes, metrics)} selected={selected} />
        </div>
      </div>
    </div>
  );
}
