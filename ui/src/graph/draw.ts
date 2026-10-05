import type { RowPayload } from '../api/gen/RowPayload';
import { avatarLane } from '../avatars/color';
import { initials } from '../format/initials';
import { STASH_ICON_BOX, STASH_ICON_STROKE, traceStashIcon } from '../icons/stash';
import { laneX, pathLength, segmentPath, tracePath, type Metrics, type PathOp } from './geometry';
import { connectorLine, dashLength, dashOffset, ringDash, snapScroll } from './pixels';
import { decodeSegment } from './segments';

export interface DrawOptions {
  rows: RowPayload[];
  first: number;
  last: number; // exclusive
  scrollTop: number;
  width: number;
  height: number;
  metrics: Metrics;
  colors: readonly string[];
  nodeFill: string;
  /** The text colour on each `colors` entry (the theme's resolved `laneText`): a commit node's
   * initials on its avatar colour, as the `<Avatar>` component's. */
  laneText?: readonly string[];
  /** Initials color inside commit nodes when `laneText` is omitted (theme `node-text`); white
   * when that is omitted too. */
  nodeText?: string;
  /** The collapse zone's shade at its darkest (theme `collapse-strip`), a black at some alpha so
   * the gradient fades it to transparent black; `rgba(0,0,0,SHADE_ALPHA)` when omitted. */
  stripColor?: string;
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
  /** More selected rows (a compare's or multi-selection's, K27): the same brighter band. */
  alsoSelected?: ReadonlySet<number>;
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
/** A dashed (WIP) line's dash and gap, CSS px, before rounding to whole device px (K50). */
export const WIP_DASH = 3;
/** The WIP node's dotted ring: its dash and gap, CSS px, before fitting the circumference (K50). */
export const WIP_RING_DASH = 2;

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
/** A stash node's half side: its dotted square, about a commit node's circle. */
export const stashHalf = (m: Metrics) => nodeRadius(m) * 0.95;
/** The share of the stash square the icon fills. */
export const STASH_ICON_FILL = 0.8;
/** A dash for a square of half side `s` that divides its perimeter evenly (`ringDash`'s rule). */
const squareDash = (s: number, target: number) => {
  const p = 8 * s;
  return p / (2 * Math.max(2, Math.round(p / (2 * target))));
};

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

/** The bright rail edge's x and width: a whole number of device pixels, flush with the backing
 * store's right edge, so it stays crisp at fractional DPR. */
function railEdge(width: number, dpr: number): { x: number; w: number } {
  const dev = Math.max(1, Math.round(RAIL_W * dpr));
  return { x: (Math.round(width * dpr) - dev) / dpr, w: dev / dpr };
}

/** What placing nodes needs: the draw options' geometry, so drawing and hit-testing agree. */
export type NodeGeometry = Pick<DrawOptions, 'width' | 'metrics' | 'clipped' | 'scrollX'> & { dpr?: number };

/** A row's node x in its lane, or null when it's packed: its lane's centre is outside the lane
 * area (past the zone's edge, or scrolled out on the left). By the centre, the same test as the
 * lines' clip, so every line drawn still ends in a drawn node (a lane half under the shade keeps
 * its nodes; spec §8.3 "lines never break"). Per lane: a lane is shown or packed whole. */
export function laneNodeX(o: NodeGeometry, row: RowPayload): number | null {
  const scrollX = o.scrollX ?? 0;
  const clipping = !!o.clipped || scrollX > 0;
  const { area, strip } = graphLayout(o.width, o.metrics, clipping);
  if (strip) return null;
  const x = laneX(row.lane, o.metrics) - scrollX;
  return clipping && (x < 0 || x >= area) ? null : x;
}

/** Where a row's node is drawn (its centre, CSS px in the canvas, `scrollTop` applied), packed
 * ones in the collapse zone or the strip. Packed merges draw as commit nodes, so they hit too. */
export function nodeCentre(o: NodeGeometry & { scrollTop: number }, row: RowPayload, index: number): { x: number; y: number } {
  const clipping = !!o.clipped || (o.scrollX ?? 0) > 0;
  const { packedX, strip } = graphLayout(o.width, o.metrics, clipping);
  const lane = laneNodeX(o, row);
  return { x: lane ?? (strip ? railEdge(o.width, o.dpr ?? 1).x / 2 : packedX), y: index * o.metrics.rowH - o.scrollTop + o.metrics.rowH / 2 };
}

/** The row whose drawn commit node's circle contains the point (x, y) (CSS px in the canvas), or
 * null. Only commit nodes (and the packed merges drawn as commits) count: not WIP, stash, or the
 * merge dot. */
export function nodeAt(o: NodeGeometry & { rows: RowPayload[]; scrollTop: number }, x: number, y: number): number | null {
  const i = Math.floor((y + o.scrollTop) / o.metrics.rowH);
  const row = o.rows[i];
  if (!row) return null;
  const lane = laneNodeX(o, row);
  if (row.kind !== 'commit' && !(row.kind === 'merge' && lane === null)) return null;
  const c = nodeCentre(o, row, i);
  return Math.hypot(x - c.x, y - c.y) <= nodeRadius(o.metrics) ? i : null;
}

export function drawGraph(ctx: CanvasRenderingContext2D, o: DrawOptions): void {
  const { metrics: m, colors } = o;
  const color = (i: number) => colors[i % colors.length];
  ctx.setTransform(o.dpr, 0, 0, o.dpr, 0, 0);
  ctx.clearRect(0, 0, o.width, o.height);
  const { x: railX, w: railW } = railEdge(o.width, o.dpr);
  // The band's and rail's vertical inset: the density's (H1), 2 px by default.
  const inset = m.bandInset ?? 2;
  // The scroll offset on the device grid: what the connectors and the dash phase are placed
  // against (pixels.ts).
  const scroll = snapScroll(o.scrollTop, o.dpr);

  const scrollX = o.scrollX ?? 0;
  const clipping = !!o.clipped || scrollX > 0;
  const { area, packedX, strip } = graphLayout(o.width, m, clipping);
  const r = nodeRadius(m);
  const stripX = railX / 2;
  const nodeXOf = (row: RowPayload) => laneNodeX(o, row);
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
      ctx.globalAlpha = i === o.selected || o.alsoSelected?.has(i) ? SELECTED_BAND_ALPHA : BAND_ALPHA;
      ctx.fillStyle = c;
      ctx.fillRect(x, top + inset, o.width - x, m.rowH - 2 * inset);
      ctx.globalAlpha = 1;
    }

    if (o.labeledRows.has(i)) {
      // A whole number of device pixels thick, its top edge on a device pixel row: the same
      // line (connectorLine, content coordinates) the row's DOM connector covers, so the two
      // halves meet on the same device rows at any dpr (zoom) and density (K57). Under
      // `setTransform(dpr, ...)`, an odd device width is centred on a half device pixel.
      // The checked-out branch's (J21): the graph lines' width, at full alpha.
      const head = i === o.headRow;
      const line = connectorLine(i * m.rowH, m.rowH, head ? LINE_W : 1, o.dpr);
      ctx.lineWidth = line.height;
      const y = line.centre - scroll;
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
    // Dashed (WIP) lines (K50): butt caps, a dash and gap of whole device pixels, phased by the
    // absolute content y (pixels.ts dashOffset), so the dashes run on unbroken from row to row.
    // A lane's straight dashed pieces in consecutive rows are joined into one path (a run), so
    // no dash is drawn as two abutting halves, whose antialiased seam would show.
    const dash = dashLength(WIP_DASH, o.dpr);
    const runs: { x: number; y0: number; y1: number; color: string }[] = [];
    const dashed = (color: string, path: PathOp[], offset: number) => {
      ctx.strokeStyle = color;
      ctx.lineCap = 'butt';
      ctx.setLineDash([dash, dash]);
      ctx.lineDashOffset = offset;
      ctx.beginPath();
      tracePath(ctx, path);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.lineDashOffset = 0;
      ctx.lineCap = 'round';
    };
    for (let i = o.first; i < o.last; i++) {
      const row = o.rows[i];
      const top = i * m.rowH - o.scrollTop;
      for (const packed of row.segments) {
        const seg = decodeSegment(packed);
        const path = segmentPath(seg, top, m);
        if (seg.dashed) {
          const [a, b] = path;
          if (path.length === 2 && b.op !== 'Q' && a.x === b.x) {
            const c = color(seg.color);
            const run = runs.find((r) => r.x === a.x && r.color === c && Math.abs(r.y1 - a.y) < 1e-6);
            if (run) run.y1 = b.y;
            else runs.push({ x: a.x, y0: a.y, y1: b.y, color: c });
          } else {
            // A curve, phased on its vertical part: its start (a top half, from the row above), or
            // its end (a bottom half, into the row below), where its lane's dashes continue.
            const startsVertical = b.op !== 'Q' && a.x === b.x;
            const end = path[path.length - 1];
            dashed(color(seg.color), path, dashOffset(startsVertical ? a.y + scroll : end.y + scroll - pathLength(path), dash));
          }
          continue;
        }
        ctx.strokeStyle = color(seg.color);
        ctx.beginPath();
        tracePath(ctx, path);
        ctx.stroke();
      }
    }
    for (const r of runs) dashed(r.color, [{ op: 'M', x: r.x, y: r.y0 }, { op: 'L', x: r.x, y: r.y1 }], dashOffset(r.y0 + scroll, dash));
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
    shade.addColorStop(1, o.stripColor ?? `rgba(0,0,0,${SHADE_ALPHA})`);
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
    // A dotted square holding the stash (paper tray) icon, in the lane colour (the
    // icon is the toolbar's and the sidebar's, icons/stash.ts): unlike the WIP's dotted ring,
    // it reads as a stash at a glance. Butt caps and a dash that divides the perimeter evenly,
    // as the ring's.
    const s = stashHalf(m);
    const d = squareDash(s, WIP_RING_DASH);
    ctx.lineCap = 'butt';
    ctx.setLineDash([d, d]);
    ctx.strokeStyle = c;
    ctx.fillStyle = o.nodeFill;
    ctx.rect(x - s, y - s, 2 * s, 2 * s);
    ctx.fill();
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.lineCap = 'round';
    const [lw, join] = [ctx.lineWidth, ctx.lineJoin];
    const size = 2 * s * STASH_ICON_FILL;
    ctx.lineWidth = Math.max(1, STASH_ICON_STROKE * (size / STASH_ICON_BOX) * 1.2);
    ctx.lineJoin = 'round';
    ctx.beginPath();
    traceStashIcon(ctx, x, y, size);
    ctx.stroke();
    ctx.lineWidth = lw;
    ctx.lineJoin = join;
    return;
  }
  const r = nodeRadius(m);
  const bitmap = kind === 'commit' ? (o.avatar?.(row.authorEmail) ?? null) : null;
  // A commit without a picture is the author's initials avatar, as everywhere else (the
  // `<Avatar>` component): the person's palette colour, picked by the same `avatarLane`, inside
  // the lane-coloured ring. The WIP node and the picture's backdrop keep the node fill.
  const lane = kind === 'commit' && !bitmap ? avatarLane(row.authorName, row.authorEmail, o.colors.length) : -1;
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fillStyle = lane >= 0 ? o.colors[lane] : o.nodeFill;
  ctx.fill();
  ctx.strokeStyle = c;
  if (kind === 'wip') {
    // The dotted ring (K50): butt caps (round ones would swell each dash over its gap) and a
    // dash that divides the circumference evenly, so every dash and gap is the same length,
    // with none cut short where the arc starts and ends.
    const d = ringDash(r, WIP_RING_DASH);
    ctx.lineCap = 'butt';
    ctx.setLineDash([d, d]);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.lineCap = 'round';
  } else ctx.stroke();
  if (kind === 'commit') {
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
      ctx.fillStyle = o.laneText?.[lane] ?? o.nodeText ?? '#fff';
      ctx.font = `600 ${Math.round(m.rowH * 0.32)}px system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(initials(row.authorName), x, y + 0.5);
    }
  }
}
