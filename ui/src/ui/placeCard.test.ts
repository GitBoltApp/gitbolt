import { describe, expect, it } from 'vitest';
import { placeCard } from './HoverTooltip';

// A 1000x800 window; EDGE is 8.
const a = { left: 100, top: 300, bottom: 320 };
describe('placeCard', () => {
  it('goes below the anchor when it fits', () => {
    expect(placeCard(a, { width: 300, height: 200 }, 4, 'below', 1000, 800)).toEqual({ left: 100, top: 324 });
  });
  it('flips above when there is no room below', () => {
    const low = { left: 100, top: 700, bottom: 720 };
    expect(placeCard(low, { width: 300, height: 300 }, 4, 'below', 1000, 800)).toEqual({ left: 100, top: 396 });
  });
  it('clamps to the right edge', () => {
    expect(placeCard({ ...a, left: 900 }, { width: 300, height: 100 }, 4, 'below', 1000, 800).left).toBe(692);
  });
  it('sets max-height at the window height minus margins when taller than the window', () => {
    expect(placeCard(a, { width: 300, height: 900 }, 4, 'below', 1000, 800)).toEqual({ left: 100, top: 8, maxHeight: 784 });
  });
  it('top mode moves up just enough to fit', () => {
    expect(placeCard({ left: 50, top: 700, bottom: 700 }, { width: 300, height: 200 }, 0, 'top', 1000, 800)).toEqual({ left: 50, top: 592 });
  });
});
