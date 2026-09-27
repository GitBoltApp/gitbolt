import { useVirtualizer } from '@tanstack/react-virtual';
import { memo, useCallback, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { createCommitMessageCache, type CommitMessageCache } from '../api/commitMessages';
import type { CommitMessage } from '../api/gen/CommitMessage';
import type { GraphPayload } from '../api/gen/GraphPayload';
import type { RefLabel } from '../api/gen/RefLabel';
import type { RowPayload } from '../api/gen/RowPayload';
import { copyText } from '../api/transport';
import { formatDate } from '../format/date';
import { useHoverTooltip } from '../ui/HoverTooltip';
import { useToast } from '../ui/toast';
import { ColumnResizer } from './ColumnResizer';
import { allocateColumns, autoGraphWidth, useColumnPrefs, type ColumnWidths } from './columns';
import { GraphCanvas } from './GraphCanvas';
import { METRICS } from './metrics';
import { RefLabels } from './RefLabels';
import './graph.css';

function WipSummary({ row }: { row: RowPayload }) {
  const w = row.wip!;
  const parts = [w.modified && `✎${w.modified}`, w.added && `+${w.added}`, w.deleted && `−${w.deleted}`, w.conflicted && `⚠${w.conflicted}`].filter(Boolean);
  return (
    <>
      <span className="wip-tag">// WIP</span>
      {w.worktreeName && <span className="dim"> {w.worktreeName}</span>}
      <span className="wip-counts"> {parts.join(' ')}</span>
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
 * message (summary plus full body, line breaks kept) in a scrollable tooltip. The graph payload
 * doesn't carry full bodies: the message is loaded on demand through `messages` (an LRU cache
 * over the `commitMessage` request), with "Loading…" if that takes over ~100 ms.
 * Pointer-only: the grid keeps focus on its scroll container (rows are never focused
 * themselves), and keyboard users read the selected commit's full message in the details panel
 * (§9.2).
 */
function MessageCell({ row, width, messages }: { row: RowPayload; width: number; messages?: CommitMessageCache }) {
  const isWip = row.kind === 'wip';
  const { triggerProps, tooltip } = useHoverTooltip({
    delayMs: MESSAGE_TOOLTIP_DELAY_MS,
    interactive: true,
    disabled: isWip || !messages,
    className: 'msg-tooltip',
    content: () => {
      const cached = messages!.peek(row.id);
      return cached ? renderMessage(cached) : messages!.get(row.id).then(renderMessage);
    },
  });
  return (
    <span role="gridcell" data-col="message" className="col-msg" style={{ width }} {...triggerProps}>
      {isWip ? <WipSummary row={row} /> : <><span className="msg-summary">{row.summary}</span>{row.bodyFirstLine && <span className="dim msg-body">{row.bodyFirstLine}</span>}</>}
      {tooltip}
    </span>
  );
}

const NO_LABELS: RefLabel[] = [];

interface GraphRowProps {
  row: RowPayload;
  index: number;
  start: number;
  selected: boolean;
  cols: ColumnWidths;
  labels: RefLabel[];
  messages?: CommitMessageCache;
  onSelect(index: number): void;
  onCopySha(id: string): void;
}

/**
 * One virtual row. Memoized: its props are all stable across scroll events (rows, memoized
 * widths and label lists, stable callbacks), so scrolling re-renders only the view and the
 * canvas, not every row.
 */
const GraphRow = memo(function GraphRow({ row, index, start, selected, cols, labels, messages, onSelect, onCopySha }: GraphRowProps) {
  const isWip = row.kind === 'wip';
  return (
    <div
      role="row"
      aria-rowindex={index + 1}
      aria-selected={selected}
      className="graph-row"
      // `top`, not `transform: translateY`: a transform would make each row its own
      // stacking context and trap the hover-expanded label chip under the canvas.
      style={{ top: start, height: METRICS.rowH }}
      onMouseDown={() => onSelect(index)}
    >
      <span role="gridcell" data-col="labels" className="col-labels" style={{ width: cols.labels }}>
        <RefLabels labels={labels} color={row.color} />
      </span>
      <span role="gridcell" data-col="graph" style={{ width: cols.graph }} />
      <MessageCell row={row} width={cols.message} messages={messages} />
      <span role="gridcell" data-col="author" className="col-author" style={{ width: cols.author }}>{row.authorName}</span>
      <span role="gridcell" data-col="date" className="col-date" style={{ width: cols.date }}>{isWip ? '' : formatDate(row.committerTime)}</span>
      <span role="gridcell" data-col="sha" className="col-sha" style={{ width: cols.sha }}>
        {!isWip && (
          <button type="button" data-testid="sha" className="sha" title="Copy full SHA" onMouseDown={(e) => e.stopPropagation()} onClick={() => onCopySha(row.id)}>
            {row.id.slice(0, 6)}
          </button>
        )}
      </span>
    </div>
  );
});

/**
 * `repoId`: a stable per-repo key (the repository's path) for per-repo view settings.
 * `loadMessage`: loads one commit's full message (the `commitMessage` request) for the
 * full-message tooltip; without it there's no such tooltip. Keep it stable (it keys the cache).
 */
export function GraphView({ graph, repoId, loadMessage }: { graph: GraphPayload; repoId: string; loadMessage?: (id: string) => Promise<CommitMessage> }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [scrollLeft, setScrollLeft] = useState(0);
  const [viewportH, setViewportH] = useState(0);
  const [viewportW, setViewportW] = useState(0);
  const prefs = useColumnPrefs((s) => s.prefs);
  useLayoutEffect(() => useColumnPrefs.getState().loadFor(repoId), [repoId]);
  const [selected, setSelected] = useState(-1);
  const toast = useToast((s) => s.show);

  const labelsByRow = useMemo(() => {
    const m = new Map<number, RefLabel[]>();
    for (const l of graph.labels) m.set(l.row, [...(m.get(l.row) ?? []), l]);
    return m;
  }, [graph.labels]);
  const labeledRows = useMemo(() => new Set(labelsByRow.keys()), [labelsByRow]);
  // Rendered column widths: the user's preferences, fitted to the scroll viewport's width
  // (columns.ts allocateColumns). Header cells, row cells and the canvas all read these.
  // Memoized so the (memoized) rows see the same object until a width actually changes.
  const graphW = prefs.graph ?? autoGraphWidth(graph.maxLanes, METRICS);
  const cols = useMemo(() => allocateColumns({ ...prefs, graph: graphW }, viewportW), [prefs, graphW, viewportW]);
  const messages = useMemo(() => (loadMessage ? createCommitMessageCache(loadMessage) : undefined), [loadMessage]);

  const v = useVirtualizer({
    count: graph.rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => METRICS.rowH,
    overscan: 20,
    initialRect: { width: 1200, height: 600 },
  });

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
  }, []);

  const select = useCallback((i: number) => {
    const clamped = Math.max(0, Math.min(graph.rows.length - 1, i));
    setSelected(clamped);
    v.scrollToIndex(clamped, { align: 'auto' });
  }, [graph.rows.length, v]);

  const onKeyDown = (e: KeyboardEvent) => {
    const page = Math.max(1, Math.floor(viewportH / METRICS.rowH) - 1);
    const moves: Record<string, number> = { ArrowDown: selected + 1, ArrowUp: selected - 1, PageDown: selected + page, PageUp: selected - page, Home: 0, End: graph.rows.length - 1 };
    if (e.key in moves) {
      e.preventDefault();
      select(moves[e.key]);
    }
  };

  const copySha = useCallback(async (id: string) => {
    await copyText(id);
    toast('Copied');
  }, [toast]);

  return (
    <div className="graph-panel">
      {/* Outside the scroll container (so it stays put vertically), and translated by the
          table's scrollLeft so it tracks horizontal scrolling. */}
      <div className="graph-header">
        <div className="graph-header-inner" style={{ width: cols.total, transform: `translateX(${-scrollLeft}px)` }}>
          <span data-col="labels" style={{ width: cols.labels }}><span className="col-title">BRANCH / TAG</span><ColumnResizer col="labels" name="Branch / Tag" edge="end" cols={cols} available={viewportW} /></span>
          <span data-col="graph" style={{ width: cols.graph }}><span className="col-title">GRAPH</span><ColumnResizer col="graph" name="Graph" edge="end" cols={cols} available={viewportW} /></span>
          <span data-col="message" style={{ width: cols.message }}><span className="col-title">COMMIT MESSAGE</span></span>
          <span data-col="author" style={{ width: cols.author }}><ColumnResizer col="author" name="Author" edge="start" cols={cols} available={viewportW} /><span className="col-title">AUTHOR</span></span>
          <span data-col="date" style={{ width: cols.date }}><ColumnResizer col="date" name="Date" edge="start" cols={cols} available={viewportW} /><span className="col-title">COMMIT DATE / TIME</span></span>
          <span data-col="sha" style={{ width: cols.sha }}><span className="col-title">SHA</span></span>
        </div>
      </div>
      <div className="graph-body">
        <div ref={scrollRef} className="graph-scroll" role="grid" aria-label="Commit graph" aria-rowcount={graph.rows.length} tabIndex={0} onKeyDown={onKeyDown} onScroll={(e) => {
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
                  selected={item.index === selected}
                  cols={cols}
                  labels={labelsByRow.get(item.index) ?? NO_LABELS}
                  messages={messages}
                  onSelect={select}
                  onCopySha={copySha}
                />
              );
            })}
          </div>
        </div>
        {/* Clipped to the scroll viewport (clientWidth/clientHeight exclude the scrollbars), so a
            canvas that reaches past it never paints over the vertical scrollbar. */}
        <div className="graph-canvas-clip" style={{ width: viewportW, height: viewportH }}>
          <GraphCanvas rows={graph.rows} scrollTop={scrollTop} width={cols.graph} height={viewportH} left={cols.labels - scrollLeft} metrics={METRICS} labeledRows={labeledRows} />
        </div>
      </div>
    </div>
  );
}
