export interface FrameWindow { frames: number; dropped: number; fps: number }

/** fps and the frames over 20 ms (janky) for one window of frame deltas. */
export function summarizeFrames(deltas: number[]): FrameWindow {
  if (!deltas.length) return { frames: 0, dropped: 0, fps: 0 };
  const total = deltas.reduce((a, b) => a + b, 0);
  return { frames: deltas.length, dropped: deltas.filter((d) => d > 20).length, fps: total > 0 ? deltas.length / (total / 1000) : 0 };
}

/** A rAF loop reporting one window every 500 ms. It runs only while the perf overlay is shown:
 * it's the one piece of the Debug tools that costs idle CPU (a frame every vsync). */
export function startFrameMeter(onWindow: (w: FrameWindow) => void): () => void {
  let raf = 0;
  let last = performance.now();
  let windowStart = last;
  let deltas: number[] = [];
  const tick = (now: number) => {
    deltas.push(now - last);
    last = now;
    if (now - windowStart >= 500) {
      onWindow(summarizeFrames(deltas));
      deltas = [];
      windowStart = now;
    }
    raf = requestAnimationFrame(tick);
  };
  raf = requestAnimationFrame(tick);
  return () => cancelAnimationFrame(raf);
}
