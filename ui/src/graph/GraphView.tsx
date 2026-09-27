import { useVirtualizer } from '@tanstack/react-virtual';
import { useCallback, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import type { GraphPayload } from '../api/gen/GraphPayload';
import type { RefLabel } from '../api/gen/RefLabel';
import type { RowPayload } from '../api/gen/RowPayload';
import { copyText } from '../api/transport';
import { formatDate } from '../format/date';
import { useToast } from '../ui/toast';
import { GraphCanvas } from './GraphCanvas';
import type { Metrics } from './geometry';
import { RefLabels } from './RefLabels';
import './graph.css';

const METRICS: Metrics = { rowH: 22, laneW: 16, padX: 8 };
const LABEL_W = 200;

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

export function GraphView({ graph }: { graph: GraphPayload }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportH, setViewportH] = useState(0);
  const [selected, setSelected] = useState(-1);
  const toast = useToast((s) => s.show);

  const labelsByRow = useMemo(() => {
    const m = new Map<number, RefLabel[]>();
    for (const l of graph.labels) m.set(l.row, [...(m.get(l.row) ?? []), l]);
    return m;
  }, [graph.labels]);
  const labeledRows = useMemo(() => new Set(labelsByRow.keys()), [labelsByRow]);
  const graphW = Math.min(400, Math.max(64, graph.maxLanes * METRICS.laneW + 2 * METRICS.padX));

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
    const ro = new ResizeObserver(() => setViewportH(el.clientHeight));
    ro.observe(el);
    setViewportH(el.clientHeight);
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

  const copySha = async (id: string) => {
    await copyText(id);
    toast('Copied');
  };

  return (
    <div className="graph-panel">
      <div className="graph-header" role="presentation">
        <span style={{ width: LABEL_W }}>BRANCH / TAG</span>
        <span style={{ width: graphW }}>GRAPH</span>
        <span className="col-msg">COMMIT MESSAGE</span>
        <span className="col-author">AUTHOR</span>
        <span className="col-date">COMMIT DATE / TIME</span>
        <span className="col-sha">SHA</span>
      </div>
      <div className="graph-body">
        <div ref={scrollRef} className="graph-scroll" role="grid" aria-label="Commit graph" aria-rowcount={graph.rows.length} tabIndex={0} onKeyDown={onKeyDown} onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}>
          <div style={{ height: v.getTotalSize(), position: 'relative' }}>
            {v.getVirtualItems().map((item) => {
              const row = graph.rows[item.index];
              const isWip = row.kind === 'wip';
              return (
                <div
                  key={row.id}
                  role="row"
                  aria-rowindex={item.index + 1}
                  aria-selected={item.index === selected}
                  className="graph-row"
                  style={{ transform: `translateY(${item.start}px)`, height: METRICS.rowH }}
                  onMouseDown={() => select(item.index)}
                >
                  <span role="gridcell" className="col-labels" style={{ width: LABEL_W }}>
                    <RefLabels labels={labelsByRow.get(item.index) ?? []} color={row.color} />
                  </span>
                  <span role="gridcell" style={{ width: graphW }} />
                  <span role="gridcell" className="col-msg">
                    {isWip ? <WipSummary row={row} /> : <>{row.summary}{row.bodyFirstLine && <span className="dim"> {row.bodyFirstLine}</span>}</>}
                  </span>
                  <span role="gridcell" className="col-author">{row.authorName}</span>
                  <span role="gridcell" className="col-date">{isWip ? '' : formatDate(row.authorTime)}</span>
                  <span role="gridcell" className="col-sha">
                    {!isWip && (
                      <button type="button" data-testid="sha" className="sha" title="Copy full SHA" onMouseDown={(e) => e.stopPropagation()} onClick={() => void copySha(row.id)}>
                        {row.id.slice(0, 6)}
                      </button>
                    )}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
        <GraphCanvas rows={graph.rows} scrollTop={scrollTop} width={graphW} height={viewportH} left={LABEL_W} metrics={METRICS} labeledRows={labeledRows} />
      </div>
    </div>
  );
}
