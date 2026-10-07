/** One backend call as the transport saw it (the perf overlay's list, spec §16.2). */
export interface CallSample { method: string; ms: number; ok: boolean; at: number }
export const CALL_CAPACITY = 50;

/**
 * The Debug tools' own traffic: the Commands and Requests tabs' polls, the log file's writes (every action logs
 * one), the modal's logs folder and diagnostics. Not recorded, so the overlay neither lists nor
 * re-renders for what the overlay and the Debug modal do themselves.
 */
export const DEBUG_METHODS: ReadonlySet<string> = new Set(['commandLog', 'requestLog', 'logFrontend', 'logsDir', 'diagnostics', 'openLogsFolder', 'setDebugLogging']);

const buffer: CallSample[] = [];
const listeners = new Set<() => void>();
/** Replaced (never mutated) on each call, so useSyncExternalStore sees a stable snapshot between changes. */
let snapshot: CallSample[] = [];

/** Called by the transport for every backend call: a push and a slice of at most 50, cheap enough to leave on. */
export function recordCall(s: CallSample): void {
  if (DEBUG_METHODS.has(s.method)) return;
  buffer.push(s);
  if (buffer.length > CALL_CAPACITY) buffer.shift();
  snapshot = buffer.slice();
  for (const l of listeners) l();
}

export const recentCalls = (): CallSample[] => snapshot;

export function subscribeCalls(l: () => void): () => void {
  listeners.add(l);
  return () => { listeners.delete(l); };
}
