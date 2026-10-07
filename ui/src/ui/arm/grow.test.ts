import { describe, expect, it } from 'vitest';
import { armPlacement } from './grow';

// A 300px panel at x 100–400, in a wider window.
const panel = { left: 100, right: 400 };

describe('which way an armed label grows (armPlacement)', () => {
  it('a control at the right edge of its panel grows left, its right edge fixed', () => {
    expect(armPlacement({ left: 330, right: 390 }, panel, 220, null)).toEqual({ grow: 'left', maxWidth: 290 });
  });

  it('a control at the left edge grows right', () => {
    expect(armPlacement({ left: 110, right: 170 }, panel, 220, null)).toEqual({ grow: 'right', maxWidth: 290 });
  });

  it('a preferred side is kept while the label fits there', () => {
    expect(armPlacement({ left: 200, right: 260 }, panel, 150, 'left')).toEqual({ grow: 'left', maxWidth: 160 });
    expect(armPlacement({ left: 200, right: 260 }, panel, 150, 'right').grow).toBe('right');
  });

  it("a preferred side without room gives way to the side with more; neither: the roomier one, clipped to the panel", () => {
    expect(armPlacement({ left: 330, right: 390 }, panel, 220, 'right')).toEqual({ grow: 'left', maxWidth: 290 });
    expect(armPlacement({ left: 200, right: 260 }, panel, 500, null)).toEqual({ grow: 'right', maxWidth: 200 });
  });

  it('never wider than the panel lets it be', () => {
    expect(armPlacement({ left: 100, right: 400 }, panel, 600, null).maxWidth).toBe(300);
  });
});
