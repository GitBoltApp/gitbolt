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
  /** The graph's lanes need more width than the column has (F2): the collapse zone shows, and
   * the nodes of lanes that don't fit are packed into it (F11, graphLayout). */
  clipped?: boolean;
  /** The lane scroll (the Graph column's own horizontal scrollbar), CSS px: lanes shift left by
   * it, and the ones scrolled out are packed too. Implies clipping when above 0. */
  scrollX?: number;
  /** The selected row's index: its band is drawn brighter (H14). */
  selected?: number;
  /** A second selected row (a compare's other side, K15): the same brighter band. */
  alsoSelected?: number;
  /** The checked-out branch's row (HEAD's label): its label connector is a graph line, the
   * lines' width in the full lane colour, not the quiet 1 px at 25% (J21). */
  headRow?: number;
}

/** Alpha of the per-row lane-color band (ruling R10). */
export const BAND_ALPHA = 0.18;
/** The selected row's band: brighter (H14; the selected band reads as its lane colour at ~52%
 * against ~11% for the others). */
export const SELECTED_BAND_ALPHA = 0.5;
/** Width, in CSS px, of the solid lane-colored rail at the graph column's right edge. */
export const RAIL_W = 2;
/** Alpha of the chip-to-node connector: 25% (feedback F8),
 * so it reads quieter than the graph lines it crosses. `.ref-connector` in graph.css matches. */
export const CONNECTOR_ALPHA = 0.25;
/** The graph lines' width, in CSS px; also the checked-out branch's connector (J21). */
export const LINE_W = 2;

/**
 * The collapse zone (spec §8.3, F11; ruling R11). While the lanes need more width than the
 * Graph column has, its right edge becomes a zone one node wide where every commit whose lane doesn't fit is drawn,
 * packed into ONE column and dimmed; a gradient shade just left of it marks "hidden nodes go
 * here". Lines stop at the zone (clipped to the lane area); row bands and the rail run through it.
 * At ~1.33x zoom: a 26 px node with ~4 px either side, the 2 px rail, a
 * 16 px shade darkening to ~61% of the background, packed nodes at ~50%.
 */
/** Gap, CSS px, either side of a packed node in the zone. */
export const ZONE_GAP = 3;
/** Width of the gradient shade left of the zone, CSS px. */
export const SHADE_W = 12;
/** The shade's darkest alpha (black), at the zone's edge; it fades to 0 over SHADE_W. */
export const SHADE_ALPHA = 0.4;
/** Alpha of a packed node: dimmed, so the lanes that are shown read first. */
export const PACKED_ALPHA = 0.5;

/** A commit node's radius; every node of the zone and the strip is this size. */
export const nodeRadius = (m: Metrics) => m.rowH * 0.36;
/** The collapse zone's width: a node, a gap either side and the rail. */
export const zoneWidth = (m: Metrics) => Math.ceil(2 * nodeRadius(m)) + 2 * ZONE_GAP + RAIL_W;

export interface GraphLayout {
  /** The collapse zone's width (0 while the lanes fit). */
  zone: number;
  /** The lane area's width: lines are clipped to it, and a node must fit in it or be packed. */
  area: number;
  /** The packed column's centre x: mid-zone, left of the rail. */
  packedX: number;
  /** Not even lane 0's whole node fits (the column at or near its 48 px minimum, at every
   * density): the graph is a strip of packed (dimmed) nodes, one per row, and nothing else (F11). */
  strip: boolean;
}

/** The Graph column's horizontal layout at `width` CSS px. `clipped`: the lanes need more width
 * than that (GraphView), or they're scrolled. Shared by drawGraph and GraphView (its lane
 * scrollbar spans the lane area). */
export function graphLayout(width: number, m: Metrics, clipped: boolean): GraphLayout {
  if (!clipped) return { zone: 0, area: width, packedX: width, strip: false };
  const zone = zoneWidth(m);
  const area = width - zone;
  return { zone, area, packedX: area + (zone - RAIL_W) / 2, strip: laneX(0, m) + nodeRadius(m) > area };
}

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

  const scrollX = o.scrollX ?? 0;
  const clipping = !!o.clipped || scrollX > 0;
  const { area, packedX, strip } = graphLayout(o.width, m, clipping);
  const r = nodeRadius(m);
  const stripX = railX / 2;
  /** A row's node x in its lane, or null when it's packed: its lane's centre is outside the lane
   * area (past the zone's edge, or scrolled out on the left). By the centre, the same test as
   * the lines' clip, so every line drawn still ends in a drawn node (a lane half under the shade
   * keeps its nodes; spec §8.3 "lines never break"). Per lane: a lane is shown or packed whole. */
  const nodeXOf = (row: RowPayload): number | null => {
    if (strip) return null;
    const x = laneX(row.lane, m) - scrollX;
    return clipping && (x < 0 || x >= area) ? null : x;
  };
  /** Where a packed row's node sits. */
  const packedAt = strip ? stripX : packedX;

  // Row bands, and the label connector on labeled rows, before any lines or nodes so those
  // never get painted over. The strip has no bands.
  for (let i = o.first; i < o.last; i++) {
    const row = o.rows[i];
    const top = i * m.rowH - o.scrollTop;
    const nx = nodeXOf(row);
    const c = color(row.color);

    if (!strip) {
      // A packed row's band fills the zone (from the lane area's edge).
      const x = nx ?? area;
      ctx.globalAlpha = i === o.selected || i === o.alsoSelected ? SELECTED_BAND_ALPHA : BAND_ALPHA;
      ctx.fillStyle = c;
      ctx.fillRect(x, top + inset, o.width - x, m.rowH - 2 * inset);
      ctx.globalAlpha = 1;
    }

    if (o.labeledRows.has(i)) {
      // `ctx.lineWidth = 1` under `setTransform(dpr, ...)` is `dpr` *device* pixels wide, which
      // blurs unless dpr is a whole number. Draw a stroke that's a whole number of device
      // pixels wide instead (rounded, minimum 1), and snap its center to a device pixel
      // boundary: an odd device width centers on a half device pixel, an even one on a whole
      // one. All of this happens in device space (`* o.dpr` / `/ o.dpr`) so it's correct at any
      // dpr, and independent of whether `top` itself is a whole CSS pixel.
      // The checked-out branch's (J21): the graph lines' width, as a whole number of device
      // pixels, at full alpha.
      const head = i === o.headRow;
      const lwDev = Math.max(1, Math.round((head ? LINE_W : 1) * o.dpr));
      ctx.lineWidth = lwDev / o.dpr;
      const cDev = (top + m.rowH / 2) * o.dpr;
      const y = (lwDev % 2 ? Math.floor(cDev) + 0.5 : Math.round(cDev)) / o.dpr;
      ctx.strokeStyle = c;
      ctx.lineCap = 'butt';
      ctx.setLineDash([]);
      ctx.globalAlpha = head ? 1 : CONNECTOR_ALPHA;
      ctx.beginPath();
      ctx.moveTo(0, y);
      // To the node; a packed one's left edge (the connector reaches it, spec §8.3).
      ctx.lineTo(nx ?? packedAt - r, y);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
  }

  ctx.lineWidth = LINE_W;
  ctx.lineCap = 'round';

  if (!strip) {
    // While clipping, the lines are cut at the zone (none enters it, none joins a packed
    // node) and shifted by the lane scroll.
    if (clipping) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, 0, area, o.height);
      ctx.clip();
      if (scrollX) ctx.translate(-scrollX, 0);
    }
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
    if (clipping) ctx.restore();
  }

  // Nodes after all lines so lines never cross over them: the lanes' first, then (after the
  // shade) the packed column's.
  for (let i = o.first; i < o.last; i++) {
    const row = o.rows[i];
    const x = nodeXOf(row);
    if (x !== null) drawNode(ctx, o, row, x, i * m.rowH - o.scrollTop + m.rowH / 2, color(row.color), false);
  }
  if (clipping && !strip) {
    const shade = ctx.createLinearGradient(area - SHADE_W, 0, area, 0);
    shade.addColorStop(0, 'rgba(0,0,0,0)');
    shade.addColorStop(1, `rgba(0,0,0,${SHADE_ALPHA})`);
    ctx.fillStyle = shade;
    ctx.fillRect(area - SHADE_W, 0, SHADE_W, o.height);
  }
  if (clipping) {
    // Every node that ran off its lane is dimmed (R11), the strip's too: there, every lane has.
    ctx.globalAlpha = PACKED_ALPHA;
    for (let i = o.first; i < o.last; i++) {
      const row = o.rows[i];
      if (nodeXOf(row) === null) drawNode(ctx, o, row, packedAt, i * m.rowH - o.scrollTop + m.rowH / 2, color(row.color), true);
    }
    ctx.globalAlpha = 1;
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

/** One row's node at (x, y), in lane colour `c`. `packed`: in the collapse zone or the strip,
 * where a merge is drawn as a full node like the rest of the column (a dot there would read as a
 * gap). */
function drawNode(ctx: CanvasRenderingContext2D, o: DrawOptions, row: RowPayload, x: number, y: number, c: string, packed: boolean): void {
  const m = o.metrics;
  const kind = packed && row.kind === 'merge' ? 'commit' : row.kind;
  ctx.beginPath();
  if (kind === 'merge') {
    ctx.arc(x, y, m.rowH * 0.18, 0, Math.PI * 2);
    ctx.fillStyle = c;
    ctx.fill();
    return;
  }
  if (kind === 'stash') {
    const s = m.rowH * 0.28;
    ctx.setLineDash([2, 2]);
    ctx.strokeStyle = c;
    ctx.fillStyle = o.nodeFill;
    ctx.rect(x - s, y - s, 2 * s, 2 * s);
    ctx.fill();
    ctx.stroke();
    ctx.setLineDash([]);
    return;
  }
  const r = nodeRadius(m);
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fillStyle = o.nodeFill;
  ctx.fill();
  ctx.strokeStyle = c;
  ctx.setLineDash(kind === 'wip' ? [2, 2] : []);
  ctx.stroke();
  ctx.setLineDash([]);
  if (kind === 'commit') {
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
