import { useLayoutEffect, useRef, useState } from 'react';
import type { RowPayload } from '../api/gen/RowPayload';
import { GRAPH_COLORS } from '../theme/graphColors';
import { drawGraph } from './draw';
import type { Metrics } from './geometry';

interface Props { rows: RowPayload[]; scrollTop: number; width: number; height: number; left: number; metrics: Metrics; labeledRows: Set<number> }

export function GraphCanvas({ rows, scrollTop, width, height, left, metrics, labeledRows }: Props) {
  const ref = useRef<HTMLCanvasElement>(null);
  const nodeFillRef = useRef<string | undefined>(undefined);
  const [dpr, setDpr] = useState(() => window.devicePixelRatio || 1);

  // Moving the window to a monitor with a different scale factor (or the OS changing zoom)
  // doesn't resize anything, so nothing else here would notice a stale backing-store size.
  // `matchMedia`'s query only matches at the dpr it was created with, so each firing re-arms
  // a fresh query at the new dpr rather than listening once.
  useLayoutEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const mql = window.matchMedia(`(resolution: ${dpr}dppx)`);
    const onChange = () => setDpr(window.devicePixelRatio || 1);
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, [dpr]);

  useLayoutEffect(() => {
    const canvas = ref.current;
    if (!canvas || height <= 0) return;
    const bw = Math.round(width * dpr), bh = Math.round(height * dpr);
    if (canvas.width !== bw) canvas.width = bw;
    if (canvas.height !== bh) canvas.height = bh;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const first = Math.max(0, Math.floor(scrollTop / metrics.rowH));
    const last = Math.min(rows.length, Math.ceil((scrollTop + height) / metrics.rowH) + 1);
    // `--app-bg0` doesn't change over a component's lifetime, so read it once and cache it
    // instead of calling getComputedStyle on every draw.
    if (nodeFillRef.current === undefined) {
      nodeFillRef.current = getComputedStyle(document.documentElement).getPropertyValue('--app-bg0').trim() || '#1c1e23';
    }
    drawGraph(ctx, { rows, first, last, scrollTop, width, height, metrics, colors: GRAPH_COLORS, nodeFill: nodeFillRef.current, labeledRows, dpr });
  }, [rows, scrollTop, width, height, metrics, labeledRows, dpr]);

  return <canvas ref={ref} className="graph-canvas" data-testid="graph-canvas" style={{ left, width, height }} />;
}
