import { Check, Copy, TriangleAlert } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api/client';
import type { CommandLogEntry } from '../api/gen/CommandLogEntry';
import { copyAndSay, relativeTime, seconds } from '../app/activityLog';

/** How often the open Commands tab re-reads the backend's ring (R10): no event, just a poll while shown. */
export const COMMAND_POLL_MS = 1000;

/** No exit code means git was killed (cancel, timeout) or never started: a failure too. */
export const commandFailed = (e: CommandLogEntry) => e.exitCode !== 0;

export function filterCommands(entries: CommandLogEntry[], text: string, failedOnly: boolean): CommandLogEntry[] {
  const needle = text.trim().toLowerCase();
  return entries.filter((e) => {
    if (failedOnly && !commandFailed(e)) return false;
    if (!needle) return true;
    return `${e.args.join(' ')}\n${e.cwd}\n${e.stderr}`.toLowerCase().includes(needle);
  });
}

const quote = (a: string) => (/^[\w@%+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`);
/** The command as it would be typed (the args are already redacted by the backend). */
export const commandLine = (e: CommandLogEntry) => `$ git ${e.args.map(quote).join(' ')}`;
const exitText = (e: CommandLogEntry) => (e.exitCode === null ? 'no exit code' : `exit ${e.exitCode}`);

export function commandText(e: CommandLogEntry, now = Date.now()): string {
  const head = `#${e.id} · ${new Date(e.startedMs).toLocaleString()} (${relativeTime(e.startedMs, now)}) · ${exitText(e)} · ${seconds(e.durationMs)} · ${e.cwd}`;
  return [head, commandLine(e), e.stderr.trimEnd()].filter(Boolean).join('\n');
}

/** Same ring as last time? The ring only grows at its end (and drops at its start once full). */
const sameRing = (a: CommandLogEntry[], b: CommandLogEntry[]) =>
  a.length === b.length && a[0]?.id === b[0]?.id && a[a.length - 1]?.id === b[b.length - 1]?.id;

/** The Debug modal's Commands tab (R10, spec §5.2): every git command the backend ran (its ring
 * of 1000), newest first, as a selectable timeline. `focusId` (an error's Details) is scrolled to
 * and highlighted. */
export function CommandLogView({ focusId }: { focusId: number | null }) {
  const [entries, setEntries] = useState<CommandLogEntry[] | null>(null);
  const [text, setText] = useState('');
  const [failedOnly, setFailedOnly] = useState(false);
  const focused = useRef<HTMLLIElement>(null);
  const scrolledTo = useRef<number | null>(null);

  useEffect(() => {
    let live = true;
    const load = () => api.commandLog().then((next) => {
      if (live) setEntries((prev) => (prev && sameRing(prev, next) ? prev : next));
    }, () => {});
    void load();
    const timer = setInterval(load, COMMAND_POLL_MS);
    return () => { live = false; clearInterval(timer); };
  }, []);

  const shown = useMemo(() => (entries ? filterCommands(entries, text, failedOnly).reverse() : []), [entries, text, failedOnly]);
  const now = useMemo(() => Date.now(), [shown]); // eslint-disable-line react-hooks/exhaustive-deps

  // Scroll to the focused command once, when it first renders (not on every poll).
  useEffect(() => {
    if (focusId === null || scrolledTo.current === focusId || !focused.current) return;
    scrolledTo.current = focusId;
    focused.current.scrollIntoView({ block: 'center' });
  }, [focusId, shown]);

  const missing = entries !== null && focusId !== null && !entries.some((e) => e.id === focusId);
  return (
    <>
      <div className="debug-toolbar">
        <input type="search" className="debug-search" aria-label="Filter commands" placeholder="Filter: args, folder, stderr" value={text} onChange={(e) => setText(e.target.value)} />
        <label className="activity-filter"><input type="checkbox" checked={failedOnly} onChange={(e) => setFailedOnly(e.target.checked)} /> Failed only</label>
        <span className="debug-count">{entries ? `${shown.length} of ${entries.length}` : ''}</span>
        <button type="button" className="activity-copy-all" disabled={shown.length === 0} onClick={() => void copyAndSay(shown.map((e) => commandText(e, now)).join('\n\n'))}>Copy all</button>
      </div>
      {missing && <p className="activity-empty">Command #{focusId} is no longer in the log: it keeps the last 1000.</p>}
      <ol className="activity-list">
        {entries === null && <li className="activity-empty">Loading…</li>}
        {entries !== null && shown.length === 0 && <li className="activity-empty">{entries.length ? 'No command matches' : 'No git commands yet'}</li>}
        {shown.map((e) => {
          const failed = commandFailed(e);
          const Icon = failed ? TriangleAlert : Check;
          const isFocus = e.id === focusId;
          return (
            <li key={e.id} ref={isFocus ? focused : undefined} aria-current={isFocus || undefined} className={`debug-entry${failed ? ' failed' : ''}`}>
              <div className="activity-meta">
                <Icon size={14} aria-hidden />
                <span className="activity-time">{new Date(e.startedMs).toLocaleString()} · {relativeTime(e.startedMs, now)}</span>
                <span>#{e.id}</span>
                <span className="activity-result">{exitText(e)}</span>
                <span>{seconds(e.durationMs)}</span>
                <span className="debug-cwd">{e.cwd}</span>
                <button type="button" className="icon-button" aria-label="Copy entry" onClick={() => void copyAndSay(commandText(e, now))}><Copy size={13} /></button>
              </div>
              <pre className="activity-msg"><span className="activity-cmd">{commandLine(e)}</span>{e.stderr.trim() ? `\n${e.stderr.trimEnd()}` : ''}</pre>
            </li>
          );
        })}
      </ol>
    </>
  );
}
