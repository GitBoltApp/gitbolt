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
  /** A loaded avatar for an author, drawn inside the node instead of initials (spec §8.3). */
  avatar?: (email: string) => ImageBitmap | null;
  /** The graph's lanes need more width than the column has: part of it is cut off (F2). */
  clipped?: boolean;
  /** The selected row's index: its band is drawn brighter (H14). */
  selected?: number;
}

/** Alpha of the per-row lane-color band (ruling R10). */
export const BAND_ALPHA = 0.18;
/** The selected row's band: brighter (H14; the selected band reads as its lane colour at ~52%
 * against ~11% for the others). */
export const SELECTED_BAND_ALPHA = 0.5;
/** Width, in CSS px, of the overflow strip at the graph column's right edge, drawn only while the
 * graph is wider than the column (F2): a solid panel in the app background (`nodeFill`, i.e.
 * `--app-bg0`), a solid panel 14 px wide,
 * over the cut-off lanes. */
export const STRIP_W = 14;
/** Width, in CSS px, of the solid lane-colored rail at the graph column's right edge. */
export const RAIL_W = 2;
/** Alpha of the chip-to-node connector: 25% (feedback F8),
 * so it reads quieter than the graph lines it crosses. `.ref-connector` in graph.css matches. */
export const CONNECTOR_ALPHA = 0.25;

export function drawGraph(ctx: CanvasRenderingContext2D, o: DrawOptions): void {
  const { metrics: m, colors } = o;
  const color = (i: number) => colors[i % colors.length];
  ctx.setTransform(o.dpr, 0, 0, o.dpr, 0, 0);
  ctx.clearRect(0, 0, o.width, o.height);
  const railDev = Math.max(1, Math.round(RAIL_W * o.dpr));
  const railX = (Math.round(o.width * o.dpr) - railDev) / o.dpr;
  const railW = railDev / o.dpr;
  // The band's and rail's vertical inset: the density's (H1), 2 px by default.
  const inset = m.bandInset ?? 2;

  // Row bands, and the label connector on labeled rows, before any lines or nodes so those
  // never get painted over.
  for (let i = o.first; i < o.last; i++) {
    const row = o.rows[i];
    const top = i * m.rowH - o.scrollTop;
    const x = laneX(row.lane, m);
    const c = color(row.color);

    ctx.globalAlpha = i === o.selected ? SELECTED_BAND_ALPHA : BAND_ALPHA;
    ctx.fillStyle = c;
    ctx.fillRect(x, top + inset, o.width - x, m.rowH - 2 * inset);
    ctx.globalAlpha = 1;

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
      ctx.globalAlpha = CONNECTOR_ALPHA;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(x, y);
      ctx.stroke();
      ctx.globalAlpha = 1;
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
      const bitmap = o.avatar?.(row.authorEmail) ?? null;
      if (bitmap) {
        // Inside the ring: the lane-coloured stroke stays visible around the picture.
        const ir = r - 1;
        ctx.save();
        ctx.beginPath();
        ctx.arc(x, y, ir, 0, Math.PI * 2);
        ctx.clip();
        // The bitmap is decoded larger than a node (for the details panel): downscale smoothly.
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(bitmap, x - ir, y - ir, 2 * ir, 2 * ir);
        ctx.restore();
      } else {
        ctx.fillStyle = '#fff';
        ctx.font = `600 ${Math.round(m.rowH * 0.32)}px system-ui, sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(initials(row.authorName), x, y + 0.5);
      }
    }
  }

  // The overflow strip (F2), over the lines and nodes it cuts off, only while the lanes don't fit.
  // Like the rail, a whole number of device pixels, flush with the backing store's right edge.
  //
  // F11 (narrow-graph node rendering, next) must revisit both the draw order here (the strip
  // paints over nodes; F11 keeps a node visible when its lane is past the column) and the
  // `clipped` definition (GraphView: column narrower than every lane plus padding).
  if (o.clipped) {
    const stripDev = Math.round(STRIP_W * o.dpr);
    ctx.globalAlpha = 1;
    ctx.fillStyle = o.nodeFill;
    ctx.fillRect((Math.round(o.width * o.dpr) - stripDev) / o.dpr, 0, stripDev / o.dpr, o.height);
  }
  // The bright rail edge on every row, last: solid lane color, full alpha. Sized and placed in
  // device pixels (a whole number of them, flush with the backing store's right edge) so it stays
  // crisp at fractional DPR.
  for (let i = o.first; i < o.last; i++) {
    const top = i * m.rowH - o.scrollTop;
    ctx.fillStyle = color(o.rows[i].color);
    ctx.fillRect(railX, top + inset, railW, m.rowH - 2 * inset);
  }
}
