import { describe, expect, it } from 'vitest';
import { centered, clampSwipe, clampView, DEFAULT_STEP, fitScale, nextStepIndex, pixelated, startView, stepLabel, SWIPE_MARGIN_PX, ZOOM_STEPS, zoomAround } from './zoom';

describe('image zoom', () => {
  it('fits, centres and labels', () => {
    expect(fitScale(400, 200, 200, 200)).toBe(0.5);
    expect(fitScale(4, 4, 400, 300)).toBe(10);
    expect(centered(2, 100, 50, 400, 300)).toEqual({ scale: 2, x: 100, y: 100 });
    expect([pixelated(1), pixelated(1.1), pixelated(2)]).toEqual([false, true, true]);
  });

  it('a fine ladder of steps (H24), and 100% is where an image opens (H23)', () => {
    expect(ZOOM_STEPS.map(stepLabel)).toEqual(['Fit', '10%', '25%', '33%', '50%', '67%', '75%', '90%', '100%', '110%', '125%', '150%', '175%', '200%', '250%', '300%', '400%', '500%', '600%', '800%', '1000%']);
    expect(ZOOM_STEPS[DEFAULT_STEP]).toBe(1);
  });

  it('zooms around the cursor and steps through every numeric level (Ctrl+wheel)', () => {
    const v = zoomAround({ scale: 1, x: 10, y: 20 }, 4, 110, 70);
    expect(v).toEqual({ scale: 4, x: -290, y: -130 });
    expect((110 - v.x) / v.scale).toBe(100);
    const at = (s: number) => ZOOM_STEPS.indexOf(s as (typeof ZOOM_STEPS)[number]);
    expect(nextStepIndex(1, 1)).toBe(at(1.1));
    expect(nextStepIndex(1, -1)).toBe(at(0.9));
    expect(nextStepIndex(10, 1)).toBe(at(10));
    expect(nextStepIndex(0.1, -1)).toBe(at(0.1));
    expect(nextStepIndex(0.7, 1)).toBe(at(0.75));
    expect(nextStepIndex(0.7, -1)).toBe(at(0.67));
  });

  it('an image that fits on an axis stays centred there: no pan (H27)', () => {
    // 100×50 at 1× in a 400×300 box fits both ways: any pan snaps back to the centre.
    expect(clampView({ scale: 1, x: 350, y: -40 }, 100, 50, 400, 300)).toEqual({ scale: 1, x: 150, y: 125 });
  });

  it('an image larger than the box on an axis pans there, but never off-screen (H27)', () => {
    // 800×50 at 1× in a 400×300 box: x in [-400, 0]; y fits, so centred.
    expect(clampView({ scale: 1, x: 20, y: 0 }, 800, 50, 400, 300)).toEqual({ scale: 1, x: 0, y: 125 });
    expect(clampView({ scale: 1, x: -500, y: 0 }, 800, 50, 400, 300)).toEqual({ scale: 1, x: -400, y: 125 });
    expect(clampView({ scale: 1, x: -123, y: 0 }, 800, 50, 400, 300)).toEqual({ scale: 1, x: -123, y: 125 });
  });

  it('an image opens at its top left where it overflows, centred where it fits (H23)', () => {
    expect(startView(1, 800, 50, 400, 300)).toEqual({ scale: 1, x: 0, y: 125 });
    expect(startView(1, 100, 50, 400, 300)).toEqual({ scale: 1, x: 150, y: 125 });
  });

  it('the swipe handle stays inside the visible image, a margin from its edges (H28)', () => {
    // The image spans 100..300 px of a 400 px box.
    const view = { scale: 1, x: 100, y: 0 };
    expect(clampSwipe(390, view, 200, 400)).toBe(300 - SWIPE_MARGIN_PX);
    expect(clampSwipe(0, view, 200, 400)).toBe(100 + SWIPE_MARGIN_PX);
    expect(clampSwipe(200, view, 200, 400)).toBe(200);
    // An image wider than the box: its visible part is the whole box.
    expect(clampSwipe(400, { scale: 1, x: -100, y: 0 }, 800, 400)).toBe(400 - SWIPE_MARGIN_PX);
    // Too small on screen for the margin (6 px): its own edges.
    expect(clampSwipe(400, { scale: 1, x: 197, y: 0 }, 6, 400)).toBe(203);
  });
});
