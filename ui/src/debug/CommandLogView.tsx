import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api/client';
import type { CommandLogEntry } from '../api/gen/CommandLogEntry';
import { copyAndSay, relativeTime, seconds } from '../app/activityLog';
import { DebugCheck, DebugRow, type Pill } from './DebugRow';

/** How often the open Commands tab re-reads the backend's ring (R10): no event, just a poll while shown. */
export const COMMAND_POLL_MS = 1000;

/** No exit code means git was killed (cancel, timeout) or never started: a failure too. */
export const commandFailed = (e: CommandLogEntry) => e.exitCode !== 0;

/** git's global options before the subcommand; the ones taking a separate value. */
const GLOBAL_WITH_VALUE = new Set(['-c', '-C', '--git-dir', '--work-tree', '--namespace', '--exec-path', '--config-env']);

/** The subcommand of `args` (`status`, `fetch`, …), past git's global options. */
export function subcommandOf(args: readonly string[]): string | null {
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (GLOBAL_WITH_VALUE.has(a)) { i++; continue; }
    if (a.startsWith('-')) continue;
    return a;
  }
  return null;
}

/** Subcommands that only read: the frequent background ones (status, diff, log, …). */
const READS = new Set([
  'status', 'diff', 'diff-files', 'diff-index', 'diff-tree', 'log', 'show', 'rev-parse', 'rev-list',
  'cat-file', 'ls-files', 'ls-tree', 'ls-remote', 'for-each-ref', 'show-ref', 'check-attr',
  'check-ignore', 'merge-base', 'merge-tree', 'blame', 'describe', 'name-rev', 'grep', 'shortlog',
  'count-objects', 'var', 'version', 'help', 'whatchanged', 'range-diff', 'cherry', 'patch-id',
]);

/** Whether a command only read the repository. Ambiguous ones (`config`, `branch`, `remote`,
 * `stash`, `worktree`, `hash-object`, `symbolic-ref`) count as reads only in their listing or
 * reading forms. */
export function isReadCommand(e: CommandLogEntry): boolean {
  const sub = subcommandOf(e.args);
  // No subcommand: `git --version`, `git --exec-path` and the like only read.
  if (!sub) return true;
  if (READS.has(sub)) return true;
  const rest = e.args.slice(e.args.indexOf(sub) + 1);
  const has = (...flags: string[]) => rest.some((a) => flags.includes(a) || flags.some((f) => a.startsWith(`${f}=`)));
  switch (sub) {
    case 'config': return has('--get', '--get-all', '--get-regexp', '--get-urlmatch', '--list', '-l', '--show-origin', '--show-scope') || rest[0] === 'get' || rest[0] === 'list';
    case 'stash': return rest[0] === 'list' || rest[0] === 'show';
    case 'worktree': return rest[0] === 'list';
    case 'remote': return rest.length === 0 || rest[0] === '-v' || rest[0] === 'get-url' || rest[0] === 'show';
    case 'branch': return rest.length === 0 || has('--list', '-l', '--contains', '--merged', '--no-merged', '--show-current') || rest.every((a) => a.startsWith('-') && !['-d', '-D', '-m', '-M', '-c', '-C', '-f', '-u', '--delete', '--move', '--copy', '--force', '--set-upstream-to', '--unset-upstream'].includes(a));
    case 'hash-object': return !has('-w');
    case 'symbolic-ref': return rest.filter((a) => !a.startsWith('-')).length <= 1;
    default: return false;
  }
}

export function filterCommands(entries: CommandLogEntry[], text: string, failedOnly: boolean, actionsOnly = false, keep: number | null = null): CommandLogEntry[] {
  const needle = text.trim().toLowerCase();
  return entries.filter((e) => {
    if (failedOnly && !commandFailed(e)) return false;
    // A failed read stays (it's why the log is open), and so does the command an error points at.
    if (actionsOnly && e.id !== keep && !commandFailed(e) && isReadCommand(e)) return false;
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
  // On by default: the frequent background reads (status, diff, log, …) drown the actions.
  const [actionsOnly, setActionsOnly] = useState(true);
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

  const shown = useMemo(() => (entries ? filterCommands(entries, text, failedOnly, actionsOnly, focusId).reverse() : []), [entries, text, failedOnly, actionsOnly, focusId]);
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
        <input type="search" className="debug-search" aria-label="Filter commands" placeholder="Filter: args, dir, stderr" value={text} onChange={(e) => setText(e.target.value)} />
        <DebugCheck label="Hide reads" checked={actionsOnly} onChange={setActionsOnly} />
        <DebugCheck label="Failed only" checked={failedOnly} onChange={setFailedOnly} />
        <span className="debug-count">{entries ? `${shown.length} of ${entries.length}` : ''}</span>
        <button type="button" className="activity-copy-all" disabled={shown.length === 0} onClick={() => void copyAndSay(shown.map((e) => commandText(e, now)).join('\n\n'))}>Copy all</button>
      </div>
      {missing && <p className="activity-empty">Command #{focusId} is no longer in the log: it keeps the last 1000.</p>}
      <ol className="activity-list">
        {entries === null && <li className="activity-empty">Loading…</li>}
        {entries !== null && shown.length === 0 && <li className="activity-empty">{entries.length ? 'No command matches' : 'No git commands yet'}</li>}
        {shown.map((e) => {
          const failed = commandFailed(e);
          const isFocus = e.id === focusId;
          const line = commandLine(e);
          const pills: Pill[] = [{ text: folderName(e.cwd), title: e.cwd, mono: true }, { text: `#${e.id}` }];
          if (failed) pills.push({ text: exitText(e), bad: true });
          return (
            <DebugRow
              key={e.id} className="debug-entry" liRef={isFocus ? focused : undefined} current={isFocus}
              status={failed ? 'failed' : 'ok'} at={e.startedMs} now={now}
              label={<span className="activity-cmd">{line}</span>} title={line} pills={pills} ms={e.durationMs}
              copy={() => commandText(e, now)}
              detail={() => (
                <pre>
                  <span className="debug-cmd-line">{line}</span>
                  {`\n${e.cwd} · ${exitText(e)}`}
                  {e.stderr.trim() && <>{'\n'}<span className={failed ? 'debug-err' : undefined}>{e.stderr.trimEnd()}</span></>}
                </pre>
              )}
              defaultOpen={failed || isFocus}
            />
          );
        })}
      </ol>
    </>
  );
}

/** The last part of a folder path (the pill; the whole path is its tooltip). */
const folderName = (cwd: string) => cwd.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || cwd;
