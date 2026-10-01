import { afterEach, expect, it, vi } from 'vitest';
import { startFrameMeter, summarizeFrames } from './frameMeter';

afterEach(() => vi.unstubAllGlobals());

it('reports fps and dropped (over 20 ms) frames for a window', () => {
  const w = summarizeFrames([...Array(58).fill(16.7), 40, 34]);
  expect(w.frames).toBe(60);
  expect(w.dropped).toBe(2);
  expect(w.fps).toBeCloseTo(60 / ((58 * 16.7 + 74) / 1000), 1);
  expect(summarizeFrames([])).toEqual({ frames: 0, dropped: 0, fps: 0 });
});

it('reports a window every 500 ms of frames, and stops on its stop', () => {
  let queued: FrameRequestCallback | null = null;
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { queued = cb; return 1; });
  const cancel = vi.fn();
  vi.stubGlobal('cancelAnimationFrame', cancel);
  vi.spyOn(performance, 'now').mockReturnValue(0);
  const seen: number[] = [];
  const stop = startFrameMeter((w) => seen.push(w.frames));
  for (let t = 20; t <= 500; t += 20) queued!(t);
  expect(seen).toEqual([25]);
  stop();
  expect(cancel).toHaveBeenCalledWith(1);
  vi.mocked(performance.now).mockRestore();
});
