import { describe, expect, it } from 'vitest';
import { centered, clampSwipe, clampView, DEFAULT_STEP, fitScale, nearestStepIndex, nextStepIndex, pixelated, startView, stepLabel, SWIPE_VIEWPORT_EDGE_PX, wheelAccumulator, ZOOM_STEPS, zoomAround } from './zoom';

describe('image zoom', () => {
  it('fits, centres and labels', () => {
    expect(fitScale(400, 200, 200, 200)).toBe(0.5);
    expect(fitScale(4, 4, 400, 300)).toBe(10);
    expect(centered(2, 100, 50, 400, 300)).toEqual({ scale: 2, x: 100, y: 100 });
    expect([pixelated(1), pixelated(1.1), pixelated(2)]).toEqual([false, true, true]);
  });

  it('a fine ladder of steps (H24), and 100% is where an image opens (H23)', () => {
    // K12: Fit is a button now, not the slider's bottom stop — the ladder's own minimum (10%) is.
    expect(ZOOM_STEPS.map(stepLabel)).toEqual(['10%', '25%', '33%', '50%', '67%', '75%', '90%', '100%', '110%', '125%', '150%', '175%', '200%', '250%', '300%', '400%', '500%', '600%', '800%', '1000%']);
    expect(ZOOM_STEPS[DEFAULT_STEP]).toBe(1);
  });

  it('finds the rung closest to an arbitrary scale (K12/K13: Fit or a typed % rarely land on one)', () => {
    const at = (s: number) => ZOOM_STEPS.indexOf(s as (typeof ZOOM_STEPS)[number]);
    expect(nearestStepIndex(1)).toBe(at(1));
    expect(nearestStepIndex(0.83)).toBe(at(0.9));
    expect(nearestStepIndex(0.81)).toBe(at(0.75));
    expect(nearestStepIndex(0.05)).toBe(0); // below the ladder's own minimum: clamps to it
    expect(nearestStepIndex(20)).toBe(ZOOM_STEPS.length - 1); // above the maximum
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

  it('the swipe handle travels the whole image, 0% to 100%, and is kept only inside the viewport (J10)', () => {
    // The image spans 100..300 px of a 400 px box: its own edges, no margin inside it.
    const view = { scale: 1, x: 100, y: 0 };
    expect(clampSwipe(390, view, 200, 400)).toBe(300);
    expect(clampSwipe(0, view, 200, 400)).toBe(100);
    expect(clampSwipe(200, view, 200, 400)).toBe(200);
    // A tiny one (6 px on screen) too.
    expect(clampSwipe(400, { scale: 1, x: 197, y: 0 }, 6, 400)).toBe(203);
    expect(clampSwipe(0, { scale: 1, x: 197, y: 0 }, 6, 400)).toBe(197);
    // An image wider than the box (zoomed in): the viewport's edges, clear of the panel resizer
    // beside it.
    expect(clampSwipe(400, { scale: 1, x: -100, y: 0 }, 800, 400)).toBe(400 - SWIPE_VIEWPORT_EDGE_PX);
    expect(clampSwipe(-50, { scale: 1, x: -100, y: 0 }, 800, 400)).toBe(SWIPE_VIEWPORT_EDGE_PX);
    // One exactly as wide as the box: the same.
    expect(clampSwipe(400, { scale: 1, x: 0, y: 0 }, 400, 400)).toBe(400 - SWIPE_VIEWPORT_EDGE_PX);
    // The edge is only what keeps the 3 px line on screen and off the resizer: a few px.
    expect(SWIPE_VIEWPORT_EDGE_PX).toBeLessThanOrEqual(4);
  });

  it('a mouse notch is one zoom step (up zooms in); a trackpad pinch accumulates, and turning back starts over', () => {
    const wheel = wheelAccumulator();
    const px = (deltaY: number) => ({ deltaY, deltaMode: 0 });
    expect(wheel(px(100))).toBe(-1);
    expect(wheel({ deltaY: -3, deltaMode: 1 })).toBe(1);
    expect([wheel(px(20)), wheel(px(20)), wheel(px(20))]).toEqual([0, 0, -1]);
    expect([wheel(px(30)), wheel(px(-30)), wheel(px(30))]).toEqual([0, 0, 0]);
    expect(wheel(px(0))).toBe(0);
  });
});
