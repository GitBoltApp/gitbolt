// The requests the demo answered, newest last: what the Debug panel's request and command logs
// show. The last MAX are kept.
import type { CommandLogEntry } from '../api/gen/CommandLogEntry';
import type { GbErrorKind } from '../api/gen/GbErrorKind';
import type { RequestLogEntry } from '../api/gen/RequestLogEntry';
import { redact } from './engine/remotes';

export interface RequestRecord { method: string; params: unknown; startedMs: number; durationMs: number; error: unknown }

const MAX = 1000;
const records: RequestRecord[] = [];

/** `error`: null, or the GbError the request failed with. */
export function recordRequest(method: string, params: unknown, startedMs: number, durationMs: number, error: unknown): void {
  records.push({ method, params, startedMs, durationMs, error });
  if (records.length > MAX) records.splice(0, records.length - MAX);
}

export function requestRecords(): readonly RequestRecord[] {
  return records;
}

// The core's log.rs (`params_summary`, `SUMMARY_KEYS`): an allowlist, so content never reaches a
// summary whatever a request carries.
const SUMMARY_KEYS = new Set([
  'repo', 'worktree', 'path', 'oldPath', 'rev', 'id', 'oid', 'sha', 'number', 'remote', 'branch', 'base', 'target', 'name', 'host', 'kind', 'url', 'to', 'staged',
  'limit', 'tag', 'upstream', 'spec', 'pin', 'old', 'new', 'mode', 'scope', 'entry', 'background', 'dest',
]);
// The typed structs a request's params nest (Request.ts): only these are read into the summary.
// Free-form maps are not (settings, profile, a diagnostics ui, undo's confirm and interactiveRebase's
// expect), so no name or url in a setting can reach the log.
const TYPED_STRUCTS = new Set([
  'spec', 'old', 'new', 'source', 'fallback', 'mrHead', 'selection', 'base', 'scope', 'target', 'upstream', 'remote', 'branch',
  'options', 'edit', 'review', 'note', 'comment', 'req', 'parts', 'rows', 'how', 'onDiverged', 'intent',
]);
const SUMMARY_LIMIT = 240;
const VALUE_LIMIT = 120;
const ERROR_LIMIT = 2000;
const UNLOGGED = new Set(['commandLog', 'requestLog', 'logFrontend']);
const ids = new WeakMap<RequestRecord, number>();
let nextRequest = 1;
const commands: CommandLogEntry[] = [];
let nextCommand = 1;

/** A request's identifying params as `key=value` pairs: the summary keys only, values redacted and
 * cut, the whole redacted and capped. A typed struct's fields are read through (a `spec`'s
 * `worktree` shows as `worktree=…`); nothing else is. */
export function paramsSummary(params: unknown): string {
  const parts: string[] = [];
  const collect = (v: unknown): void => {
    if (v === null || typeof v !== 'object') return;
    if (Array.isArray(v)) return v.forEach(collect);
    for (const [key, value] of Object.entries(v)) {
      if (SUMMARY_KEYS.has(key) && ['string', 'number', 'boolean'].includes(typeof value)) parts.push(`${key}=${shownValue(value as string | number | boolean)}`);
      else if (TYPED_STRUCTS.has(key)) collect(value);
    }
  };
  collect(params);
  const text = redact(parts.join(' '));
  const chars = Array.from(text);
  return chars.length > SUMMARY_LIMIT ? `${chars.slice(0, SUMMARY_LIMIT).join('')}…` : text;
}

/** Redacted before it's cut, so a credential whose `@` falls past the cut can't leak its user:pass. */
function shownValue(value: string | number | boolean): string {
  if (typeof value !== 'string') return String(value);
  const chars = Array.from(redact(value));
  let shown = chars.slice(0, VALUE_LIMIT).join('');
  if (chars.length > VALUE_LIMIT) shown += '…';
  return shown === '' || /\s/.test(shown) ? `"${shown}"` : shown;
}

/** The Requests tab's entries, oldest first: 1a's records, without the logs' own traffic. Each
 * keeps the id it got when first listed. */
export function requestEntries(): RequestLogEntry[] {
  const out: RequestLogEntry[] = [];
  for (const r of records) {
    if (UNLOGGED.has(r.method)) continue;
    let id = ids.get(r);
    if (id === undefined) {
      id = nextRequest++;
      ids.set(r, id);
    }
    const e = r.error as { kind?: GbErrorKind; message?: unknown } | null;
    const message = e && typeof e.message === 'string' ? e.message : e ? '' : null;
    out.push({
      id,
      method: r.method,
      params: paramsSummary(r.params),
      startedMs: r.startedMs,
      durationMs: r.durationMs,
      error: e ? (e.kind ?? 'Other') : null,
      errorMessage: message === null ? null : Array.from(redact(message)).slice(0, ERROR_LIMIT).join(''),
      commands: [],
    });
  }
  return out;
}

/** A git command a demo write stands for (plan 3's writes add theirs), for the Commands tab. */
export function recordCommand(args: string[], cwd: string, durationMs: number): void {
  commands.push({ id: nextCommand++, args: args.map((a) => redact(a)), cwd, startedMs: Date.now(), durationMs, exitCode: 0, stderr: '' });
  if (commands.length > MAX) commands.shift();
}

export function commandEntries(): CommandLogEntry[] {
  return [...commands];
}
