import { describe, expect, it } from 'vitest';
import { centered, fitScale, nextStepIndex, pixelated, stepLabel, ZOOM_STEPS, zoomAround } from './zoom';

describe('image zoom', () => {
  it('fits, centres and labels', () => {
    expect(fitScale(400, 200, 200, 200)).toBe(0.5);
    expect(fitScale(4, 4, 400, 300)).toBe(10);
    expect(centered(2, 100, 50, 400, 300)).toEqual({ scale: 2, x: 100, y: 100 });
    expect(ZOOM_STEPS.map(stepLabel)).toEqual(['Fit', '25%', '50%', '100%', '200%', '400%', '600%', '800%', '1000%']);
    expect([pixelated(1), pixelated(2)]).toEqual([false, true]);
  });

  it('zooms around the cursor and steps through the numeric levels', () => {
    const v = zoomAround({ scale: 1, x: 10, y: 20 }, 4, 110, 70);
    expect(v).toEqual({ scale: 4, x: -290, y: -130 });
    expect((110 - v.x) / v.scale).toBe(100);
    expect([nextStepIndex(1, 1), nextStepIndex(1, -1), nextStepIndex(10, 1), nextStepIndex(0.25, -1), nextStepIndex(0.7, 1)]).toEqual([4, 2, 8, 1, 3]);
  });
});
