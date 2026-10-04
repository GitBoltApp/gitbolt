/**
 * The forge poller's contract (spec #4 §3.4). 4B implements `ForgePoller`, one per active tab,
 * beside `FetchScheduler` (app/fetchSchedule.ts). It polls:
 * - when the tab becomes active (`activate`);
 * - on the fetch timer (`timer`);
 * - when the window gets the focus back (`focus`);
 * - after any GitBolt forge write (`write`);
 * - every ~20 s while a visible MR/PR's pipeline runs (`fast`).
 * Background tabs never poll. Requests are conditional (ETags), so an unchanged poll is nearly
 * free. A failed poll keeps the data shown, with its "last updated" note (spec #4 §6).
 */
export const FAST_POLL_MS = 20_000;

export type PollReason = 'activate' | 'timer' | 'focus' | 'write' | 'fast';

export interface PollOutcome {
  /** A visible MR/PR has a running (or pending) pipeline. */
  runningPipeline: boolean;
  /** The server's `Poll-Interval` / `X-Poll-Interval`, in ms: a floor. */
  serverIntervalMs: number | null;
}

export interface ForgePollDeps {
  now(): number;
  isMinimized(): Promise<boolean>;
  poll(reason: PollReason): Promise<PollOutcome>;
}

export interface ForgePoller {
  start(): void;
  stop(): void;
  onFocus(focused: boolean): void;
  afterWrite(): void;
}

/** The delay before the next timed poll: the fetch interval, or `FAST_POLL_MS` while a pipeline
 * runs (never slower than the timer), never under the server's interval. `null`: the fetch
 * interval is off, so there are no timed polls (focus, activation and writes still poll). */
export function nextPollDelay(fetchIntervalMs: number, last: PollOutcome | null): number | null {
  if (!(fetchIntervalMs > 0)) return null;
  const base = last?.runningPipeline ? Math.min(fetchIntervalMs, FAST_POLL_MS) : fetchIntervalMs;
  return Math.max(base, last?.serverIntervalMs ?? 0);
}

// --- 4B T7: the poller ---
/** A window focus polls again only once the last full poll is at least this old. */
export const FOCUS_GAP_MS = 10_000;
/** The longest wait after failed polls. */
export const MAX_BACKOFF_MS = 15 * 60_000;

/** The wait after `failures` failed polls in a row: the fetch interval (at least a minute),
 * doubled for each further failure, at most MAX_BACKOFF_MS. `pollForge` returns it as the
 * outcome's `serverIntervalMs` (a floor), so the contract above stays as it is. */
export function backoffMs(fetchIntervalMs: number, failures: number): number {
  if (failures <= 0) return 0;
  return Math.min(MAX_BACKOFF_MS, Math.max(60_000, fetchIntervalMs) * 2 ** (failures - 1));
}

const FULL: readonly PollReason[] = ['activate', 'timer', 'focus', 'write'];
/** Of a queued reason and a new one, the one to run: a full poll beats a fast one. */
const stronger = (queued: PollReason | null, next: PollReason): PollReason => (queued === null || (queued === 'fast' && next !== 'fast') ? next : queued);

/**
 * One tab's forge poller (spec #4 §3.4). RepoTab starts it while the tab shows and stops it when
 * it hides or closes, so a background tab never polls and showing one polls it at once:
 * - `start`: an `activate` poll, then timed ones;
 * - timed: `nextPollDelay` after each poll (the fetch interval; ~20 s while a pipeline runs; never
 *   under the server's interval or the failure backoff). A timed poll is `fast` (only what's on
 *   screen) unless the fetch interval has passed since the last full poll (`timer`). A tick while
 *   the window is minimized is skipped, and made up when the window gets the focus back;
 * - `onFocus(true)`: a full poll, unless one ran in the last FOCUS_GAP_MS;
 * - `afterWrite`: a full poll at once (a GitBolt forge write).
 * One poll at a time: a reason arriving meanwhile runs right after it.
 */
export function createForgePoller(fetchIntervalMs: number, deps: ForgePollDeps): ForgePoller {
  let started = false;
  let running = false;
  let queued: PollReason | null = null;
  let missed = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let last: PollOutcome | null = null;
  let lastFullAt = -Infinity;
  let failures = 0;
  let gen = 0;

  const clear = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };
  const schedule = () => {
    clear();
    const base = nextPollDelay(fetchIntervalMs, last);
    const delay = base === null ? null : Math.max(base, backoffMs(fetchIntervalMs, failures));
    if (delay !== null) timer = setTimeout(() => { void tick(); }, delay);
  };
  const run = async (reason: PollReason): Promise<void> => {
    if (!started) return;
    if (running) {
      queued = stronger(queued, reason);
      return;
    }
    const g = gen;
    running = true;
    missed = false;
    clear();
    if (FULL.includes(reason)) lastFullAt = deps.now();
    let outcome: PollOutcome | null = null;
    try {
      outcome = await deps.poll(reason);
    } catch {
      outcome = null;
    }
    if (g !== gen) return; // stopped (and maybe restarted) meanwhile: a stale result does nothing
    running = false;
    if (outcome) {
      failures = 0;
      last = outcome;
    } else {
      failures += 1;
      last = { runningPipeline: last?.runningPipeline ?? false, serverIntervalMs: last?.serverIntervalMs ?? null };
    }
    const next = queued;
    queued = null;
    if (next !== null) void run(next);
    else schedule();
  };
  const tick = async () => {
    timer = null;
    if (!started) return;
    const g = gen;
    const minimized = await deps.isMinimized();
    if (g !== gen || !started) return;
    if (minimized) {
      missed = true;
      return;
    }
    void run(deps.now() - lastFullAt >= fetchIntervalMs ? 'timer' : 'fast');
  };
  return {
    start() {
      if (started) return;
      started = true;
      gen += 1;
      running = false;
      queued = null;
      missed = false;
      last = null;
      failures = 0;
      lastFullAt = -Infinity;
      void run('activate');
    },
    stop() {
      started = false;
      gen += 1;
      clear();
      queued = null;
      missed = false;
    },
    onFocus(focused) {
      if (!started || !focused) return;
      if (missed || deps.now() - lastFullAt >= FOCUS_GAP_MS) void run('focus');
    },
    afterWrite() {
      void run('write');
    },
  };
}
// --- end 4B T7 ---
