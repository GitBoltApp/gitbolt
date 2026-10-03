import { useEffect, useState, useSyncExternalStore } from 'react';
import { useActivityUi } from '../app/activityLog';
import { recentCalls, subscribeCalls } from './calls';
import { startFrameMeter, type FrameWindow } from './frameMeter';
import './debug.css';

function Overlay() {
  const [frames, setFrames] = useState<FrameWindow>({ frames: 0, dropped: 0, fps: 0 });
  // The app's calls only: the Debug tools' own (DEBUG_METHODS) aren't recorded, so the overlay
  // never re-renders for its own or the Debug modal's traffic.
  const calls = useSyncExternalStore(subscribeCalls, recentCalls);
  // A window that reads the same as the last one keeps the state, so an idle overlay stays still.
  useEffect(() => startFrameMeter((w) => setFrames((p) => (Math.round(p.fps) === Math.round(w.fps) && p.dropped === w.dropped ? p : w))), []);
  return (
    <section aria-label="Performance" className="perf-overlay">
      <div className="perf-fps">{frames.fps.toFixed(0)} fps · {frames.dropped} dropped</div>
      <table>
        <tbody>
          {calls.slice().reverse().map((c, i) => (
            <tr key={`${c.at}-${i}`} className={c.ok ? undefined : 'failed'}><td>{c.method}</td><td>{c.ms.toFixed(1)} ms</td></tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

/** The perf overlay (the Debug modal's toggle, spec §16.2): fps over the last 500 ms and the last
 * 50 backend calls with their times. Clicks pass through it. Mounted only while it's on, so the
 * frame loop costs nothing otherwise. */
export function PerfOverlay() {
  const on = useActivityUi((s) => s.perfOverlay);
  return on ? <Overlay /> : null;
}
