import { describe, expect, it } from 'vitest';
import { placeMenu, placeSubmenu } from './position';

const vp = { w: 1000, h: 800 };

describe('menu placement', () => {
  it('opens at the pointer when it fits', () => {
    expect(placeMenu(100, 100, { w: 200, h: 300 }, vp)).toEqual({ left: 100, top: 100 });
  });
  it('flips left and up at the screen edges', () => {
    expect(placeMenu(900, 700, { w: 200, h: 300 }, vp)).toEqual({ left: 700, top: 400 });
  });
  it('never leaves the viewport even when flipping would', () => {
    expect(placeMenu(50, 50, { w: 1200, h: 900 }, vp)).toEqual({ left: 4, top: 4 });
  });
  it('K70: a menu dropped from a button opens under it; at the right edge it right-aligns to the button, not mirroring around its left corner', () => {
    const fits = { left: 100, right: 180, top: 30, bottom: 60 };
    expect(placeMenu(100, 60, { w: 200, h: 300 }, vp, fits)).toEqual({ left: 100, top: 60 });
    const atEdge = { left: 900, right: 990, top: 30, bottom: 60 };
    expect(placeMenu(900, 60, { w: 260, h: 300 }, vp, atEdge)).toEqual({ left: 730, top: 60 });
    // Too low: opens upward from the button's top.
    const low = { left: 100, right: 180, top: 700, bottom: 730 };
    expect(placeMenu(100, 730, { w: 200, h: 300 }, vp, low)).toEqual({ left: 100, top: 400 });
  });
  it('submenus open right, else left, and clamp vertically', () => {
    expect(placeSubmenu({ left: 100, right: 300, top: 100 }, { w: 200, h: 100 }, vp)).toEqual({ left: 300, top: 100 });
    expect(placeSubmenu({ left: 700, right: 900, top: 750 }, { w: 200, h: 100 }, vp)).toEqual({ left: 500, top: 696 });
  });
});
