import { useEffect, useMemo, useState } from 'react';
import { api } from '../api/client';
import type { RequestLogEntry } from '../api/gen/RequestLogEntry';
import { copyAndSay, relativeTime, seconds, useActivityUi } from '../app/activityLog';
import { DebugCheck, DebugRow, type Pill } from './DebugRow';

/** How often the open Requests tab re-reads the backend's ring, as the Commands tab does. */
export const REQUEST_POLL_MS = 1000;
/** "Slow only" keeps the requests that took longer than this. */
export const SLOW_REQUEST_MS = 100;

export const requestFailed = (e: RequestLogEntry) => e.error !== null;

export function filterRequests(entries: RequestLogEntry[], text: string, failedOnly: boolean, slowOnly: boolean): RequestLogEntry[] {
  const needle = text.trim().toLowerCase();
  return entries.filter((e) => {
    if (failedOnly && !requestFailed(e)) return false;
    if (slowOnly && e.durationMs <= SLOW_REQUEST_MS) return false;
    if (!needle) return true;
    return `${e.method}\n${e.params}\n${e.error ?? ''}\n${e.errorMessage ?? ''}`.toLowerCase().includes(needle);
  });
}

/** Most requests take well under a millisecond: those read to a tenth. */
export const durationText = (ms: number) => (ms < 10 ? `${ms.toFixed(1)} ms` : seconds(Math.round(ms)));

const outcomeText = (e: RequestLogEntry) => (e.error === null ? 'ok' : e.errorMessage ? `${e.error}: ${e.errorMessage}` : e.error);
const requestLine = (e: RequestLogEntry) => (e.params ? `${e.method} ${e.params}` : e.method);

export function requestText(e: RequestLogEntry, now = Date.now()): string {
  const head = `#${e.id} · ${new Date(e.startedMs).toLocaleString()} (${relativeTime(e.startedMs, now)}) · ${durationText(e.durationMs)} · ${outcomeText(e)}`;
  const git = e.commands.length ? `git commands: ${e.commands.map((c) => `#${c}`).join(', ')}` : null;
  return [head, requestLine(e), git].filter(Boolean).join('\n');
}

/** Same ring as last time? It only grows at its end (and drops at its start once full). */
const sameRing = (a: RequestLogEntry[], b: RequestLogEntry[]) =>
  a.length === b.length && a[0]?.id === b[0]?.id && a[a.length - 1]?.id === b[b.length - 1]?.id;

/** The Debug modal's Requests tab: every core API request (the backend's ring of 1000: graph
 * walks, blobs, commit details, forge calls…), newest first, with its timing, outcome and the git
 * commands it ran (each one opens the Commands tab on it). */
export function RequestLogView() {
  const [entries, setEntries] = useState<RequestLogEntry[] | null>(null);
  const [text, setText] = useState('');
  const [failedOnly, setFailedOnly] = useState(false);
  const [slowOnly, setSlowOnly] = useState(false);

  useEffect(() => {
    let live = true;
    const load = () => api.requestLog().then((next) => {
      if (live) setEntries((prev) => (prev && sameRing(prev, next) ? prev : next));
    }, () => {});
    void load();
    const timer = setInterval(load, REQUEST_POLL_MS);
    return () => { live = false; clearInterval(timer); };
  }, []);

  const shown = useMemo(() => (entries ? filterRequests(entries, text, failedOnly, slowOnly).reverse() : []), [entries, text, failedOnly, slowOnly]);
  const now = useMemo(() => Date.now(), [shown]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <>
      <div className="debug-toolbar">
        <input type="search" className="debug-search" aria-label="Filter requests" placeholder="Filter: method, params, error" value={text} onChange={(e) => setText(e.target.value)} />
        <DebugCheck label="Slow only" checked={slowOnly} onChange={setSlowOnly} />
        <DebugCheck label="Failed only" checked={failedOnly} onChange={setFailedOnly} />
        <span className="debug-count">{entries ? `${shown.length} of ${entries.length}` : ''}</span>
        <button type="button" className="activity-copy-all" disabled={shown.length === 0} onClick={() => void copyAndSay(shown.map((e) => requestText(e, now)).join('\n\n'))}>Copy all</button>
      </div>
      <ol className="activity-list">
        {entries === null && <li className="activity-empty">Loading…</li>}
        {entries !== null && shown.length === 0 && <li className="activity-empty">{entries.length ? 'No request matches' : 'No requests yet'}</li>}
        {shown.map((e) => {
          const failed = requestFailed(e);
          const line = requestLine(e);
          const pills: Pill[] = [{ text: `#${e.id}` }];
          if (e.commands.length) pills.push({ text: `${e.commands.length} git`, title: `Ran ${e.commands.length} git ${e.commands.length === 1 ? 'command' : 'commands'}` });
          if (failed) pills.push({ text: e.error!, bad: true });
          return (
            <DebugRow
              key={e.id} className="debug-request" status={failed ? 'failed' : 'ok'} at={e.startedMs} now={now}
              label={<><span className="activity-cmd">{e.method}</span>{e.params && <span className="debug-params">{` ${e.params}`}</span>}</>}
              title={line} pills={pills} ms={e.durationMs} msText={durationText(e.durationMs)}
              copy={() => requestText(e, now)}
              detail={() => (
                <pre>
                  <span className="debug-cmd-line">{line}</span>
                  {`\n#${e.id} · ${new Date(e.startedMs).toLocaleString()} · ${durationText(e.durationMs)} · `}
                  <span className={failed ? 'debug-err' : undefined}>{outcomeText(e)}</span>
                  {e.commands.length > 0 && (
                    <>
                      {'\ngit commands: '}
                      {e.commands.map((c, i) => (
                        <span key={c}>
                          {i > 0 && ', '}
                          <button type="button" className="debug-link" aria-label={`Show git command #${c}`} onClick={() => useActivityUi.getState().show('commands', c)}>#{c}</button>
                        </span>
                      ))}
                    </>
                  )}
                </pre>
              )}
              defaultOpen={failed}
            />
          );
        })}
      </ol>
    </>
  );
}
