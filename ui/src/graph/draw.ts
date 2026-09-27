import type { RowPayload } from '../api/gen/RowPayload';
import { initials } from '../format/initials';
import { laneX, segmentPath, type Metrics } from './geometry';
import { decodeSegment } from './segments';

export interface DrawOptions {
  rows: RowPayload[];
  first: number;
  last: number; // exclusive
  scrollTop: number;
  width: number;
  height: number;
  metrics: Metrics;
  colors: string[];
  nodeFill: string;
  labeledRows: Set<number>;
  dpr: number;
}

/** Alpha of the per-row lane-color band (ruling R10). */
const BAND_ALPHA = 0.18;
/** Width, in CSS px, of the darker "collapse strip" at the right edge of every band. */
export const STRIP_W = 12;
const STRIP_COLOR = 'rgba(0,0,0,0.35)';

export function drawGraph(ctx: CanvasRenderingContext2D, o: DrawOptions): void {
  const { metrics: m, colors } = o;
  const color = (i: number) => colors[i % colors.length];
  ctx.setTransform(o.dpr, 0, 0, o.dpr, 0, 0);
  ctx.clearRect(0, 0, o.width, o.height);

  // Row bands, and the label connector on labeled rows, before any lines or nodes so those
  // never get painted over.
  for (let i = o.first; i < o.last; i++) {
    const row = o.rows[i];
    const top = i * m.rowH - o.scrollTop;
    const x = laneX(row.lane, m);
    const c = color(row.color);

    ctx.globalAlpha = BAND_ALPHA;
    ctx.fillStyle = c;
    ctx.fillRect(x, top + 2, o.width - x, m.rowH - 4);
    ctx.globalAlpha = 1;
    ctx.fillStyle = STRIP_COLOR;
    ctx.fillRect(o.width - STRIP_W, top + 2, STRIP_W, m.rowH - 4);

    if (o.labeledRows.has(i)) {
      // `ctx.lineWidth = 1` under `setTransform(dpr, ...)` is `dpr` *device* pixels wide, which
      // blurs unless dpr is a whole number. Draw a stroke that's a whole number of device
      // pixels wide instead (rounded, minimum 1), and snap its center to a device pixel
      // boundary: an odd device width centers on a half device pixel, an even one on a whole
      // one. All of this happens in device space (`* o.dpr` / `/ o.dpr`) so it's correct at any
      // dpr, and independent of whether `top` itself is a whole CSS pixel.
      const lwDev = Math.max(1, Math.round(o.dpr));
      ctx.lineWidth = lwDev / o.dpr;
      const cDev = (top + m.rowH / 2) * o.dpr;
      const y = (lwDev % 2 ? Math.floor(cDev) + 0.5 : Math.round(cDev)) / o.dpr;
      ctx.strokeStyle = c;
      ctx.lineCap = 'butt';
      ctx.setLineDash([]);
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(x, y);
      ctx.stroke();
    }
  }

  ctx.lineWidth = 2;
  ctx.lineCap = 'round';

  for (let i = o.first; i < o.last; i++) {
    const row = o.rows[i];
    const top = i * m.rowH - o.scrollTop;
    for (const packed of row.segments) {
      const seg = decodeSegment(packed);
      ctx.strokeStyle = color(seg.color);
      ctx.setLineDash(seg.dashed ? [3, 3] : []);
      ctx.beginPath();
      for (const p of segmentPath(seg, top, m)) {
        if (p.op === 'Q') ctx.quadraticCurveTo(p.cx, p.cy, p.x, p.y);
        else if (p.op === 'M') ctx.moveTo(p.x, p.y);
        else ctx.lineTo(p.x, p.y);
      }
      ctx.stroke();
    }
    ctx.setLineDash([]);
  }

  // Nodes after all lines so lines never cross over them.
  for (let i = o.first; i < o.last; i++) {
    const row = o.rows[i];
    const x = laneX(row.lane, m);
    const y = i * m.rowH - o.scrollTop + m.rowH / 2;
    const c = color(row.color);
    ctx.beginPath();
    if (row.kind === 'merge') {
      ctx.arc(x, y, m.rowH * 0.18, 0, Math.PI * 2);
      ctx.fillStyle = c;
      ctx.fill();
      continue;
    }
    if (row.kind === 'stash') {
      const s = m.rowH * 0.28;
      ctx.setLineDash([2, 2]);
      ctx.strokeStyle = c;
      ctx.fillStyle = o.nodeFill;
      ctx.rect(x - s, y - s, 2 * s, 2 * s);
      ctx.fill();
      ctx.stroke();
      ctx.setLineDash([]);
      continue;
    }
    const r = m.rowH * 0.36;
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = o.nodeFill;
    ctx.fill();
    ctx.strokeStyle = c;
    ctx.setLineDash(row.kind === 'wip' ? [2, 2] : []);
    ctx.stroke();
    ctx.setLineDash([]);
    if (row.kind === 'commit') {
      ctx.fillStyle = '#fff';
      ctx.font = `600 ${Math.round(m.rowH * 0.32)}px system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(initials(row.authorName), x, y + 0.5);
    }
  }
}
