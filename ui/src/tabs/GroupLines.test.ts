import { describe, expect, it } from 'vitest';
import { blendSpan, GHOST_MS, ghostLine, ghostShare, LINE_RAMP, lineSpan, trackGhost, visiblePart } from './GroupLines';

// A chip 100..134, its pill 106..128; tabs of 100 after it.
const chip = { left: 100, right: 134 };
const pill = { left: 106, right: 128 };

describe('lineSpan: one line over a group', () => {
  it('runs from the chip\'s pill through the last tab, whatever lies between', () => {
    expect(lineSpan(pill, chip, [{ left: 134, right: 234 }, { left: 234, right: 334 }])).toEqual({ left: 106, right: 334 });
    // A tab dragged into it, still away from its slot: the line reaches it.
    expect(lineSpan(pill, chip, [{ left: 134, right: 234 }, { left: 300, right: 400 }])).toEqual({ left: 106, right: 400 });
  });

  it('collapsing: it shrinks with the tabs, then back into the chip, and is gone', () => {
    expect(lineSpan(pill, chip, [{ left: 134, right: 194 }])).toEqual({ left: 106, right: 194 });
    // Under LINE_RAMP px of tabs left, it goes into the chip too (its 28 px piece, by half here),
    // to a point at the pill's left edge: no jump when the tabs are gone.
    expect(lineSpan(pill, chip, [{ left: 134, right: 134 + LINE_RAMP / 2 }])).toEqual({ left: 106, right: 106 + 14 + LINE_RAMP / 2 });
    expect(lineSpan(pill, chip, [{ left: 134, right: 135 }])!.right).toBeCloseTo(106 + 28 / LINE_RAMP + 1);
    expect(lineSpan(pill, chip, [])).toBeNull();
    // Expanding is the same, the other way: out of the chip first.
    expect(lineSpan(pill, chip, [{ left: 134, right: 134 + 2 * LINE_RAMP }])).toEqual({ left: 106, right: 134 + 2 * LINE_RAMP });
  });

  it('a group a drop would make has no chip yet: over its two tabs', () => {
    expect(lineSpan(null, null, [{ left: 300, right: 400 }, { left: 250, right: 350 }])).toEqual({ left: 250, right: 400 });
  });
});

describe('a dragged tab in a group\'s line: eased in and out, measured as drawn', () => {
  const tabs = [{ left: 134, right: 234 }];

  it('a dropped tab sliding into the last slot: the line ends where the tab is drawn, frame by frame, not at its slot', () => {
    // Slot 234..334; the tab sliding right from 190 shows only inside its slot (its clip).
    const slot = { span: [234, 334] as [number, number] };
    for (const x of [190, 220, 260, 234]) {
      const tab = visiblePart({ left: x, right: x + 100 }, slot);
      expect(ghostLine(pill, chip, tabs, tab, 1).line).toEqual({ left: 106, right: Math.min(x + 100, 334) });
    }
    // Any slot: the line spans the tabs as drawn (one still sliding aside, 150 px short of 334).
    expect(ghostLine(pill, chip, [{ left: 134, right: 234 }, { left: 184, right: 284 }], null, 0).line).toEqual({ left: 106, right: 284 });
  });

  it('dragged in, the line grows to take it in over GHOST_MS, eased; dragged out, it shrinks back', () => {
    const ghost = { left: 250, right: 350 };
    expect(ghostLine(pill, chip, tabs, ghost, 0).line).toEqual({ left: 106, right: 234 });
    expect(ghostLine(pill, chip, tabs, ghost, 0.5).line).toEqual({ left: 106, right: 292 });
    expect(ghostLine(pill, chip, tabs, ghost, 1).line).toEqual({ left: 106, right: 350 });
    // The tab moving meanwhile: the line's end follows it.
    expect(ghostLine(pill, chip, tabs, { left: 270, right: 370 }, 0.5).line).toEqual({ left: 106, right: 302 });
    const g = trackGhost(null, 't', ['a'], ['a'], 1000)!;
    expect(g).toEqual({ tab: 't', from: 0, to: 1, start: 1000 });
    expect(ghostShare(g, 1000)).toBe(0);
    expect(ghostShare(g, 1000 + GHOST_MS / 2)).toBeCloseTo(0.875); // ease-out: most of it early
    expect(ghostShare(g, 1000 + GHOST_MS)).toBe(1);
    // Out halfway in: back from where it is, not from 1.
    const out = trackGhost(g, null, ['a'], ['a'], 1000 + GHOST_MS / 2)!;
    expect(out.to).toBe(0);
    expect(out.from).toBeCloseTo(0.875);
    expect(ghostShare(out, 1000 + GHOST_MS * 1.5)).toBe(0);
    // Back in again before it's out.
    expect(trackGhost(out, 't', ['a'], ['a'], 1000 + GHOST_MS)!.to).toBe(1);
  });

  it('the drag starting: its own group\'s line has it at once; the drop committing: a member again, no ghost', () => {
    const g = trackGhost(null, 't', ['a'], ['a', 't'], 0)!;
    expect(ghostShare(g, 0)).toBe(1);
    expect(trackGhost(g, null, ['a', 't'], ['a'], 10)).toBeNull();
    // Reduced motion: no easing.
    expect(ghostShare(trackGhost(null, 't', ['a'], ['a'], 0, 0)!, 0, 0)).toBe(1);
  });

  it('the part over the lifted tab shows above it; a lone tab\'s group line grows out of its pill', () => {
    expect(ghostLine(pill, chip, tabs, { left: 200, right: 300 }, 1).over).toEqual({ left: 200, right: 300 });
    expect(ghostLine(pill, chip, tabs, { left: 200, right: 300 }, 0).over).toBeNull();
    // Its own one-tab group, dragged out: from the pill's left edge, to nothing.
    expect(blendSpan(null, { left: 106, right: 300 }, 0.5)).toEqual({ left: 106, right: 203 });
    expect(blendSpan({ left: 106, right: 300 }, null, 1)).toBeNull();
  });
});
