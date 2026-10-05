/**
 * The forge poller's contract (spec #4 §3.4). 4B implements `ForgePoller`, one per active tab,
 * beside `FetchScheduler` (app/fetchSchedule.ts). It polls:
 * - when the tab becomes active (`activate`);
 * - on the fetch timer (`timer`), never more often than once a minute, and only while the
 *   window has the focus;
 * - when the window gets the focus back (`focus`), if the last full poll is FOCUS_GAP_MS old
 *   or a tick was skipped meanwhile;
 * - after any GitBolt forge write (`write`);
 * - while a visible MR/PR's pipeline runs (`fast`): after 20 s, then 40 s, 80 s, at most 2 min
 *   while the same pipeline keeps running; a new one starts again at 20 s.
 * Background tabs never poll. Requests are conditional (ETags), so an unchanged poll is nearly
 * free. A failed poll keeps the data shown, with its "last updated" note (spec #4 §6).
 */
export const FAST_POLL_MS = 20_000;
/** The fast poll's longest wait while the same pipeline keeps running. */
export const FAST_POLL_MAX_MS = 120_000;
/** No timed poll comes sooner than this after the last (the fast poll aside). */
export const MIN_POLL_MS = 60_000;

export type PollReason = 'activate' | 'timer' | 'focus' | 'write' | 'fast';

export interface PollOutcome {
  /** A visible MR/PR has a running pipeline (`fastPollWanted`). */
  runningPipeline: boolean;
  /** The server's `Poll-Interval` / `X-Poll-Interval`, a rate limit's pacing, or the failure
   * backoff, in ms: a floor. */
  serverIntervalMs: number | null;
  /** Which pipelines run (`<number>:<head>`…): the same ones running again wait longer. */
  pipelineKey?: string | null;
  /** The poll failed (its floor is a backoff: it gets some jitter). */
  failed?: boolean;
}

export interface ForgePollDeps {
  now(): number;
  isMinimized(): Promise<boolean>;
  /** Whether the window has the focus as the poller starts (then `onFocus` says). */
  isFocused?(): Promise<boolean>;
  poll(reason: PollReason): Promise<PollOutcome>;
  /** [0, 1): the backoff's jitter (`Math.random` by default). */
  random?(): number;
}

export interface ForgePoller {
  start(): void;
  stop(): void;
  onFocus(focused: boolean): void;
  afterWrite(): void;
}

/** The fast poll's wait after `streak` polls that found the same pipelines running: 20 s, 40 s,
 * 80 s, then 2 min. */
export function fastPollMs(streak: number): number {
  return Math.min(FAST_POLL_MAX_MS, FAST_POLL_MS * 2 ** Math.max(0, streak));
}

/** The delay before the next timed poll: the fetch interval (at least MIN_POLL_MS), or the fast
 * poll's (`fastPollMs`) while a pipeline runs (never slower than the timer), never under the
 * server's interval. `null`: the fetch interval is off, so there are no timed polls (focus,
 * activation and writes still poll). */
export function nextPollDelay(fetchIntervalMs: number, last: PollOutcome | null, streak = 0): number | null {
  if (!(fetchIntervalMs > 0)) return null;
  const interval = Math.max(fetchIntervalMs, MIN_POLL_MS);
  const base = last?.runningPipeline ? Math.min(interval, fastPollMs(streak)) : interval;
  return Math.max(base, last?.serverIntervalMs ?? 0);
}

// --- 4B T7: the poller ---
/** A window focus polls again only once the last full poll is at least this old (or a tick was
 * skipped while the window was away). Shorter than MIN_POLL_MS: coming back from the forge's web
 * page (an MR merged there) shows it, as 4D's after-merge flow expects; it's one poll per return,
 * never a timer. */
export const FOCUS_GAP_MS = 10_000;
/** A backoff's wait grows by up to this share, at random: tabs and windows that failed together
 * don't all ask again at the same moment. */
export const JITTER = 0.2;
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
 * - timed: `nextPollDelay` after each poll (the fetch interval, at least a minute; the fast poll's
 *   20 s → 2 min while a pipeline runs; never under the server's interval or the failure backoff,
 *   which gets some jitter). A timed poll is `fast` (only what's on screen) unless the fetch
 *   interval has passed since the last full poll (`timer`). A tick while the window is minimized
 *   or hasn't the focus is skipped, and made up when the window gets the focus back;
 * - `onFocus(true)`: a full poll, if a tick was skipped or the last full poll is FOCUS_GAP_MS old;
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
  let focused = true;
  /** Polls in a row that found the same pipelines running (`fastPollMs`). */
  let streak = 0;
  const random = deps.random ?? Math.random;

  const clear = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };
  const schedule = () => {
    clear();
    const base = nextPollDelay(fetchIntervalMs, last, streak);
    const backoff = failures > 0 || last?.failed === true;
    const delay = base === null ? null : Math.max(base, backoffMs(fetchIntervalMs, failures)) * (backoff ? 1 + JITTER * random() : 1);
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
      const same = outcome.runningPipeline && last?.runningPipeline === true && (outcome.pipelineKey ?? null) === (last.pipelineKey ?? null);
      streak = same ? streak + 1 : 0;
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
    if (minimized || !focused) {
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
      streak = 0;
      lastFullAt = -Infinity;
      focused = true;
      const g = gen;
      void deps.isFocused?.().then((f) => { if (g === gen) focused = f; }, () => {});
      void run('activate');
    },
    stop() {
      started = false;
      gen += 1;
      clear();
      queued = null;
      missed = false;
    },
    onFocus(now) {
      focused = now;
      if (!started || !now) return;
      if (missed || deps.now() - lastFullAt >= FOCUS_GAP_MS) void run('focus');
    },
    afterWrite() {
      void run('write');
    },
  };
}
// --- end 4B T7 ---
