import { describe, expect, it } from 'vitest';
import { BAND_ALPHA, CONNECTOR_ALPHA, drawGraph, SELECTED_BAND_ALPHA, STRIP_W } from './draw';
import type { RowPayload } from '../api/gen/RowPayload';

function recorder() {
  const calls: string[] = [];
  // Numeric args are kept exact (not rounded): the device-pixel snap produces values like
  // 11.5 or 17/1.5 that a naive Math.round would collapse into indistinguishable integers,
  // hiding the exact behavior the connector's crisp-pixel math depends on.
  const ctx = new Proxy({} as Record<string, unknown>, {
    get: (_t, k: string) => (k in _t ? _t[k] : (...a: unknown[]) => { calls.push(`${k}(${a.map((x) => (typeof x === 'number' ? x : typeof x)).join(',')})`); }),
    set: (t, k: string, v) => { t[k] = v; calls.push(`${k}=${String(v)}`); return true; },
  });
  return { ctx: ctx as unknown as CanvasRenderingContext2D, calls };
}

const row = (lane: number, kind: RowPayload['kind'], segments: number[]): RowPayload => ({
  id: 'x', kind, lane, color: lane, segments, summary: '', bodyFirstLine: '', authorName: 'Ada Lovelace', authorEmail: '', authorTime: 0, committerTime: 0, parents: [], mrRefs: [], wip: null,
});

describe('drawGraph', () => {
  it('draws only visible rows, with lane colors and a node per row', () => {
    const { ctx, calls } = recorder();
    const fullLane1 = 1 | (1 << 10) | (2 << 20) | (1 << 22);
    const rows = [row(0, 'commit', [1 << 20]), row(1, 'merge', [fullLane1]), row(0, 'wip', [])];
    drawGraph(ctx, { rows, first: 1, last: 3, scrollTop: 22, width: 100, height: 44, metrics: { rowH: 22, laneW: 16, padX: 8 }, colors: ['#a', '#b'], nodeFill: '#000', labeledRows: new Set([1]), dpr: 1 });
    expect(calls.filter((c) => c.startsWith('arc(')).length).toBe(2);
    expect(calls).toContain('strokeStyle=#b');
    expect(calls.some((c) => c.startsWith('setLineDash('))).toBe(true);
  });

  it('draws a translucent band on every visible row, not only labeled ones', () => {
    const { ctx, calls } = recorder();
    // Three visible, unlabeled commit rows in different lanes.
    const rows = [row(0, 'commit', []), row(1, 'commit', []), row(2, 'commit', [])];
    drawGraph(ctx, { rows, first: 0, last: 3, scrollTop: 0, width: 100, height: 66, metrics: { rowH: 22, laneW: 16, padX: 8 }, colors: ['#a', '#b', '#c'], nodeFill: '#000', labeledRows: new Set(), dpr: 1 });
    // Two fillRect per visible row: the lane-color band and the bright lane-colored rail edge.
    // The graph fits (not clipped), so there's no overflow strip (F2).
    expect(calls.filter((c) => c.startsWith('fillRect(')).length).toBe(6);
    // No row is labeled, so no connector line should be drawn.
    expect(calls.filter((c) => c.startsWith('moveTo(0,')).length).toBe(0);
    // Bands come before any node arcs.
    expect(calls.findIndex((c) => c.startsWith('fillRect('))).toBeLessThan(calls.findIndex((c) => c.startsWith('arc(')));
  });

  it('draws the overflow strip only when the graph is clipped: a solid app-background panel, full height, over the lanes (F2)', () => {
    const base = { rows: [row(0, 'commit', [1 << 20])], first: 0, last: 1, scrollTop: 0, width: 100, height: 22, metrics: { rowH: 22, laneW: 16, padX: 8 }, colors: ['#a'], nodeFill: '#123456', labeledRows: new Set<number>(), dpr: 1 };
    const fits = recorder();
    drawGraph(fits.ctx, { ...base, clipped: false });
    expect(fits.calls).not.toContain(`fillRect(${100 - STRIP_W},0,${STRIP_W},22)`);
    expect(fits.calls).not.toContain('fillStyle=rgba(0,0,0,0.35)');
    const cut = recorder();
    drawGraph(cut.ctx, { ...base, clipped: true });
    const strip = cut.calls.indexOf(`fillRect(${100 - STRIP_W},0,${STRIP_W},22)`);
    expect(strip).toBeGreaterThan(-1);
    const before = cut.calls.slice(0, strip);
    expect(before.findLast((x) => x.startsWith('fillStyle='))).toBe('fillStyle=#123456');
    expect(before.findLast((x) => x.startsWith('globalAlpha='))).toBe('globalAlpha=1');
    // Over the lines and nodes (it hides the part of the graph that's cut off).
    expect(cut.calls.findIndex((c) => c.startsWith('arc('))).toBeGreaterThan(-1);
    const after = cut.calls.slice(strip);
    expect(after.some((c) => c.startsWith('arc(') || c === 'stroke()')).toBe(false);
  });

  it('the strip is the scrollbar thickness (14 px), snapped to whole device pixels flush with the right edge (DPR 1.5)', () => {
    expect(STRIP_W).toBe(14);
    const { ctx, calls } = recorder();
    // width 101 CSS px -> backing store round(151.5) = 152 device px; the strip is round(14 * 1.5)
    // = 21 device px, so it spans device px 131..152: CSS x 131/1.5, width 21/1.5 = 14.
    drawGraph(ctx, { rows: [row(0, 'commit', [])], first: 0, last: 1, scrollTop: 0, width: 101, height: 22, metrics: { rowH: 22, laneW: 16, padX: 8 }, colors: ['#a'], nodeFill: '#000', labeledRows: new Set(), dpr: 1.5, clipped: true });
    expect(calls).toContain(`fillRect(${131 / 1.5},0,${21 / 1.5},22)`);
  });

  it('draws a solid, full-alpha 2px rail in the lane color at the right edge, after the strip', () => {
    const { ctx, calls } = recorder();
    const rows = [row(0, 'commit', []), row(1, 'commit', [])];
    drawGraph(ctx, { rows, first: 0, last: 2, scrollTop: 0, width: 100, height: 44, metrics: { rowH: 22, laneW: 16, padX: 8 }, colors: ['#a', '#b'], nodeFill: '#000', labeledRows: new Set(), dpr: 1, clipped: true });
    for (const [top, c] of [[0, '#a'], [22, '#b']] as const) {
      const strip = calls.indexOf(`fillRect(${100 - STRIP_W},0,${STRIP_W},44)`);
      const rail = calls.indexOf(`fillRect(98,${top + 2},2,18)`);
      expect(strip).toBeGreaterThan(-1);
      expect(rail).toBeGreaterThan(strip);
      // The fill state in effect for the rail: the lane color, at full alpha.
      const before = calls.slice(0, rail);
      expect(before.findLast((x) => x.startsWith('fillStyle='))).toBe(`fillStyle=${c}`);
      expect(before.findLast((x) => x.startsWith('globalAlpha='))).toBe('globalAlpha=1');
    }
  });

  it('keeps the rail flush with the canvas edge and a whole number of device pixels wide at DPR 1.5', () => {
    const { ctx, calls } = recorder();
    // width 101 CSS px -> backing store round(151.5) = 152 device px; the rail is round(2 * 1.5) =
    // 3 device px, so it spans device px 149..152, i.e. CSS x 149/1.5, width 3/1.5 = 2.
    drawGraph(ctx, { rows: [row(0, 'commit', [])], first: 0, last: 1, scrollTop: 0, width: 101, height: 22, metrics: { rowH: 22, laneW: 16, padX: 8 }, colors: ['#a'], nodeFill: '#000', labeledRows: new Set(), dpr: 1.5 });
    expect(calls).toContain(`fillRect(${149 / 1.5},2,2,18)`);
  });

  it('insets the row band and the rail by the density\'s bandInset (H1: standard\'s bands are chip-high, 22 of 28 px)', () => {
    const { ctx, calls } = recorder();
    const rows = [row(0, 'commit', []), row(1, 'commit', [])];
    drawGraph(ctx, { rows, first: 0, last: 2, scrollTop: 0, width: 100, height: 56, metrics: { rowH: 28, laneW: 22, padX: 11, bandInset: 3 }, colors: ['#a', '#b'], nodeFill: '#000', labeledRows: new Set(), dpr: 1 });
    // Row 1: top 28, band from its node (laneX(1) = 11 + 22 + 11 = 44) to the edge.
    expect(calls).toContain('fillRect(44,31,56,22)');
    expect(calls).toContain('fillRect(98,31,2,22)');
  });

  it('the selected row\'s band is brighter (H14); the others keep BAND_ALPHA', () => {
    expect(SELECTED_BAND_ALPHA).toBeGreaterThan(2 * BAND_ALPHA);
    const { ctx, calls } = recorder();
    const rows = [row(0, 'commit', []), row(1, 'commit', []), row(0, 'commit', [])];
    drawGraph(ctx, { rows, first: 0, last: 3, scrollTop: 0, width: 100, height: 75, metrics: { rowH: 25, laneW: 16, padX: 8 }, colors: ['#a', '#b'], nodeFill: '#000', labeledRows: new Set(), dpr: 1, selected: 1 });
    const alphaFor = (rect: string) => calls.slice(0, calls.indexOf(rect)).findLast((c) => c.startsWith('globalAlpha='));
    expect(alphaFor('fillRect(16,2,84,21)')).toBe(`globalAlpha=${BAND_ALPHA}`);
    expect(alphaFor('fillRect(32,27,68,21)')).toBe(`globalAlpha=${SELECTED_BAND_ALPHA}`);
    expect(alphaFor('fillRect(16,52,84,21)')).toBe(`globalAlpha=${BAND_ALPHA}`);
  });

  it('draws the label connector only on labeled rows, from x=0 to the node, snapped to a device pixel', () => {
    const { ctx, calls } = recorder();
    const rows = [row(0, 'commit', []), row(1, 'commit', [])];
    drawGraph(ctx, { rows, first: 0, last: 2, scrollTop: 0, width: 100, height: 44, metrics: { rowH: 22, laneW: 16, padX: 8 }, colors: ['#a', '#b'], nodeFill: '#000', labeledRows: new Set([1]), dpr: 1 });
    const connectors = calls.filter((c) => c.startsWith('moveTo(0,'));
    expect(connectors.length).toBe(1);
    // Row 1's center: top(22) + rowH/2(11) = 33 CSS px = 33 device px at dpr 1 (odd device
    // width), which snaps to the half-pixel boundary below it: floor(33)+0.5 = 33.5.
    expect(connectors[0]).toBe('moveTo(0,33.5)');
    expect(calls).toContain('lineTo(32,33.5)');
    expect(calls).toContain('lineCap=butt');
    // Reset before the segment-line pass, so the connector's cap never leaks onto graph lines.
    expect(calls).toContain('lineCap=round');
  });

  it('snaps the connector to a whole device pixel, at the correct stroke width, for DPR 1/1.5/2', () => {
    // Row 0's center is top(0) + rowH/2(11) = 11 CSS px; x = laneX(0, m) = 16.
    const base = { rows: [row(0, 'commit', [])], first: 0, last: 1, scrollTop: 0, width: 100, height: 22, metrics: { rowH: 22, laneW: 16, padX: 8 }, colors: ['#a'], nodeFill: '#000', labeledRows: new Set([0]) };

    // DPR 1: a 1-device-pixel-wide stroke (odd) centers on a half CSS pixel:
    // floor(11) + 0.5 = 11.5.
    const { ctx: ctx1, calls: calls1 } = recorder();
    drawGraph(ctx1, { ...base, dpr: 1 });
    expect(calls1).toContain('lineWidth=1');
    expect(calls1).toContain('moveTo(0,11.5)');
    expect(calls1).toContain('lineTo(16,11.5)');

    // DPR 2: still a 1-device-pixel-wide stroke (its CSS width, lineWidth, halves to stay
    // 1 device px), but 11 CSS px * 2 = 22 device px is even, so it centers on a whole pixel.
    const { ctx: ctx2, calls: calls2 } = recorder();
    drawGraph(ctx2, { ...base, dpr: 2 });
    expect(calls2).toContain('lineWidth=1');
    expect(calls2).toContain('moveTo(0,11)');
    expect(calls2).toContain('lineTo(16,11)');

    // DPR 1.5: rounds to a 2-device-pixel-wide stroke (even), so it also centers on a whole
    // device pixel: 11 * 1.5 = 16.5 device px -> round(16.5) = 17 -> 17/1.5 CSS px.
    const { ctx: ctx3, calls: calls3 } = recorder();
    drawGraph(ctx3, { ...base, dpr: 1.5 });
    expect(calls3).toContain(`lineWidth=${2 / 1.5}`);
    expect(calls3).toContain(`moveTo(0,${17 / 1.5})`);
    expect(calls3).toContain(`lineTo(16,${17 / 1.5})`);
  });

  it('strokes the connector in the lane colour at 25% alpha, then restores full alpha (F8)', () => {
    const { ctx, calls } = recorder();
    const rows = [row(0, 'commit', []), row(1, 'commit', [1 << 20])];
    drawGraph(ctx, { rows, first: 0, last: 2, scrollTop: 0, width: 100, height: 44, metrics: { rowH: 22, laneW: 16, padX: 8 }, colors: ['#a', '#b'], nodeFill: '#000', labeledRows: new Set([1]), dpr: 1 });
    expect(CONNECTOR_ALPHA).toBe(0.25);
    const stroke = calls.indexOf('stroke()', calls.indexOf('moveTo(0,33.5)'));
    const before = calls.slice(0, stroke);
    expect(before.findLast((c) => c.startsWith('globalAlpha='))).toBe('globalAlpha=0.25');
    expect(before.findLast((c) => c.startsWith('strokeStyle='))).toBe('strokeStyle=#b');
    // Everything after it (the next band, graph lines, nodes) is back at full alpha.
    const after = calls.slice(stroke);
    expect(after.find((c) => c.startsWith('globalAlpha='))).toBe('globalAlpha=1');
    const firstLine = calls.findIndex((c, i) => i > stroke && c === 'lineCap=round');
    expect(calls.slice(0, firstLine).findLast((c) => c.startsWith('globalAlpha='))).toBe('globalAlpha=1');
  });

  it("the checked-out branch's connector (headRow) is the graph line's width and the full lane colour (J21)", () => {
    const rows = [row(0, 'commit', []), row(1, 'commit', [1 << 20])];
    for (const dpr of [1, 1.5, 2]) {
      const { ctx, calls } = recorder();
      drawGraph(ctx, { rows, first: 0, last: 2, scrollTop: 0, width: 100, height: 44, metrics: { rowH: 22, laneW: 16, padX: 8 }, colors: ['#a', '#b'], nodeFill: '#000', labeledRows: new Set([0, 1]), dpr, headRow: 1 });
      const moves = calls.map((c, i) => [c, i] as const).filter(([c]) => c.startsWith('moveTo(0,'));
      expect(moves).toHaveLength(2);
      const style = (at: number, prop: string) => calls.slice(0, calls.indexOf('stroke()', at)).findLast((c) => c.startsWith(`${prop}=`));
      // Row 0: the quiet 1-device-pixel line at 25%.
      expect(style(moves[0][1], 'globalAlpha'), `dpr ${dpr}`).toBe('globalAlpha=0.25');
      expect(style(moves[0][1], 'lineWidth')).toBe(`lineWidth=${Math.max(1, Math.round(dpr)) / dpr}`);
      // HEAD's row: 2 CSS px (a whole number of device pixels, centred on a device-pixel line), at full alpha.
      expect(style(moves[1][1], 'globalAlpha'), `dpr ${dpr}`).toBe('globalAlpha=1');
      expect(style(moves[1][1], 'lineWidth')).toBe(`lineWidth=${Math.round(2 * dpr) / dpr}`);
      const y = Number(/moveTo\(0,(.*)\)/.exec(moves[1][0])![1]);
      expect((y * dpr) % 1).toBe(Math.round(2 * dpr) % 2 ? 0.5 : 0);
    }
  });

  it('still snaps to a device pixel boundary with a fractional scrollTop', () => {
    const { ctx, calls } = recorder();
    const rows = [row(0, 'commit', [])];
    // scrollTop 0.3 makes `top` (and so the unsnapped center) fractional in CSS px, but the
    // device-space snap must still land the stroke on a clean device pixel boundary.
    drawGraph(ctx, { rows, first: 0, last: 1, scrollTop: 0.3, width: 100, height: 22, metrics: { rowH: 22, laneW: 16, padX: 8 }, colors: ['#a'], nodeFill: '#000', labeledRows: new Set([0]), dpr: 1 });
    // top = 0 - 0.3 = -0.3; center = -0.3 + 11 = 10.7 device px at dpr 1 -> floor(10.7)+0.5 = 10.5.
    expect(calls).toContain('moveTo(0,10.5)');
    expect(calls).toContain('lineWidth=1');
  });
  it('draws a loaded avatar bitmap clipped to the node instead of initials', () => {
    const { ctx, calls } = recorder();
    const bitmap = {} as ImageBitmap;
    const rows = [{ ...row(0, 'commit', []), authorEmail: 'ada@example.com' }, { ...row(0, 'commit', []), authorEmail: 'nobody@example.com' }];
    const asked: string[] = [];
    drawGraph(ctx, { rows, first: 0, last: 2, scrollTop: 0, width: 100, height: 50, metrics: { rowH: 25, laneW: 16, padX: 8 }, colors: ['#a'], nodeFill: '#000', labeledRows: new Set(), dpr: 1, avatar: (e) => { asked.push(e); return e === 'ada@example.com' ? bitmap : null; } });
    expect(asked).toEqual(['ada@example.com', 'nobody@example.com']);
    const clip = calls.indexOf('clip()');
    expect(clip).toBeGreaterThan(-1);
    expect(calls.slice(clip).findIndex((c) => c.startsWith('drawImage('))).toBeGreaterThan(0);
    expect(calls.filter((c) => c.startsWith('drawImage(')).length).toBe(1);
    expect(calls).toContain('save()');
    expect(calls).toContain('restore()');
    // Downscaled smoothly (the decoded bitmap is larger than the node).
    const smooth = calls.indexOf('imageSmoothingQuality=high');
    expect(smooth).toBeGreaterThan(-1);
    expect(smooth).toBeLessThan(calls.findIndex((c) => c.startsWith('drawImage(')));
    // The second row has no avatar: it keeps its initials.
    expect(calls.filter((c) => c.startsWith('fillText(')).length).toBe(1);
  });
});
