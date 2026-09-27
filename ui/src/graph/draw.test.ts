import { describe, expect, it } from 'vitest';
import { drawGraph } from './draw';
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
  id: 'x', kind, lane, color: lane, segments, summary: '', bodyFirstLine: '', authorName: 'Ada Lovelace', authorEmail: '', authorTime: 0, parents: [], wip: null,
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
    // Two fillRect per visible row: the lane-color band, then the darker collapse strip drawn over it.
    expect(calls.filter((c) => c.startsWith('fillRect(')).length).toBe(6);
    // No row is labeled, so no connector line should be drawn.
    expect(calls.filter((c) => c.startsWith('moveTo(0,')).length).toBe(0);
    // Bands come before any node arcs.
    expect(calls.findIndex((c) => c.startsWith('fillRect('))).toBeLessThan(calls.findIndex((c) => c.startsWith('arc(')));
  });

  it('draws a darker collapse strip over the last 12px of every band', () => {
    const { ctx, calls } = recorder();
    const rows = [row(0, 'commit', [])];
    drawGraph(ctx, { rows, first: 0, last: 1, scrollTop: 0, width: 100, height: 22, metrics: { rowH: 22, laneW: 16, padX: 8 }, colors: ['#a'], nodeFill: '#000', labeledRows: new Set(), dpr: 1 });
    // The strip is a second, darker fillRect at the row's right edge, drawn after the band.
    expect(calls).toContain('fillRect(88,2,12,18)');
    expect(calls).toContain('fillStyle=rgba(0,0,0,0.35)');
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
});
