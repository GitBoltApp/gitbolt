import type { DemoClock } from '../context';

export const systemClock: DemoClock = { nowMs: () => Date.now(), tzOffsetMinutes: () => -new Date().getTimezoneOffset() };

export function fixedClock(nowMs: number, tzOffsetMinutes = 0): DemoClock {
  return { nowMs: () => nowMs, tzOffsetMinutes: () => tzOffsetMinutes };
}
/** The parity suite's instant (2027-01-15T08:00:00Z): later than every fixture's commits; the harness
 *  records the goldens with the same one (`GIT_*_DATE=@1800000000 +0000`, `Api::with_clock`). */
export const PARITY_MS = 1_800_000_000_000;
