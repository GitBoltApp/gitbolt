import { ClipboardCopy, FolderOpen, Gauge, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { api } from '../api/client';
import type { RemoteLine } from '../api/gen/RemoteLine';
import { track } from '../debug/actionLog';
import { ActionLogView } from '../debug/ActionLogView';
import { CommandLogView } from '../debug/CommandLogView';
import { clockTime, DebugCheck, DebugRow, type Pill } from '../debug/DebugRow';
import { copyDiagnostics, openLogsFolder } from '../debug/diagnostics';
import { toastActionError } from '../debug/errorToast';
import { activityRows, allText, copyAndSay, useActivityUi, type DebugView } from './activityLog';
import { useModalKeys } from './modalKeys';
import { useOps, type ActivityEntry } from './ops';
import './activity.css';

const TABS: Array<[DebugView, string]> = [['activity', 'Activity'], ['commands', 'Commands'], ['actions', 'Actions']];

/** Stable (R25, the N1 lesson): the modal-keys registration never re-runs for a new `close`. */
const close = () => useActivityUi.getState().setOpen(false);
/** A header button's work, recorded in the action log; a failure toasts like any action's (R12). */
const run = (id: string, label: string, fn: () => unknown) => track(id, label, fn, (e) => toastActionError(e));

/** DOM guard: the entry keeps every line, the section renders the first so many. */
const MAX_RENDERED = 2000;

const URL = /(https?:\/\/[^\s]+)/g;

/** A line with its URLs as links (spec #2 §12.4), opened through the backend's opener. */
function Linkified({ text }: { text: string }) {
  const parts = text.split(URL);
  return <>{parts.map((p, i) => (i % 2 === 1 ? <a key={i} href={p} onClick={(ev) => { ev.preventDefault(); void api.openUrl(p); }}>{p}</a> : p))}</>;
}

/** The server's `remote:` lines, whole; boilerplate is shown but not counted. */
function ServerOutput({ lines, open }: { lines: RemoteLine[]; open: boolean }) {
  const n = lines.filter((l) => l.kind !== 'boilerplate').length;
  if (n === 0) return null;
  const shown = lines.slice(0, MAX_RENDERED);
  return (
    <details className="activity-server" open={open || undefined}>
      <summary>{`Server output (${n} ${n === 1 ? 'line' : 'lines'})`}</summary>
      <pre>{shown.map((l, i) => <div key={i} className={`remote-${l.kind}`}><Linkified text={l.text} /></div>)}{lines.length > shown.length && <div className="remote-boilerplate">{`… ${lines.length - shown.length} more lines`}</div>}</pre>
    </details>
  );
}

const lines = (n: number) => `${n} ${n === 1 ? 'line' : 'lines'}`;

/** An entry's expanded part: its command and message, the server's lines, its hook/progress output. */
function ActivityDetail({ e, runs, focused }: { e: ActivityEntry; runs: ActivityEntry[]; focused: boolean }) {
  return (
    <>
      {runs.length > 1 && <div className="debug-detail-head">{`${runs.length} identical runs, the oldest at ${clockTime(runs[runs.length - 1].at)}`}</div>}
      {(e.command || e.message) && (
        <pre className="activity-msg">
          {e.command && <span className="activity-cmd debug-cmd-line">$ {e.command}</span>}
          {e.command && e.message ? '\n' : ''}
          {e.message && <span className={e.outcome === 'failed' ? 'debug-err' : undefined}>{e.message}</span>}
        </pre>
      )}
      {e.remote.length > 0 && <ServerOutput lines={e.remote} open={focused} />}
      {e.output.length > 0 && (
        <>
          <div className="debug-detail-head">{`Output (${lines(e.output.length)})`}</div>
          <pre className="activity-output">{e.output.join('\n')}</pre>
        </>
      )}
    </>
  );
}

/** K101's timeline: every finished op, newest first. Quiet background ops are hidden by default,
 * and identical consecutive ones share a row (×N) when shown. */
function ActivityView() {
  const activity = useOps((s) => s.activity);
  const focusOp = useActivityUi((s) => s.focusOp);
  const [errorsOnly, setErrorsOnly] = useState(false);
  const [hideBackground, setHideBackground] = useState(true);
  useEffect(() => {
    if (focusOp !== null) document.querySelector(`.activity-entry[data-op="${focusOp}"]`)?.scrollIntoView?.({ block: 'nearest' });
  }, [focusOp]);
  const now = Date.now();
  const rows = useMemo(() => activityRows(activity, { errorsOnly, hideBackground, focusOp }), [activity, errorsOnly, hideBackground, focusOp]);
  const shown = rows.flat();
  const empty = activity.length === 0 ? 'No activity yet: every finished operation appears here' : errorsOnly ? 'No failures' : 'Only background activity: untick Hide background to see it';
  return (
    <>
      <div className="debug-toolbar">
        <DebugCheck label="Errors only" checked={errorsOnly} onChange={setErrorsOnly} />
        <DebugCheck label="Hide background" checked={hideBackground} onChange={setHideBackground} />
        <span className="debug-count">{shown.length} of {activity.length}</span>
        <button type="button" className="activity-copy-all" disabled={shown.length === 0} onClick={() => void copyAndSay(allText(shown, now))}>Copy all</button>
      </div>
      <ol className="activity-list">
        {rows.length === 0 && <li className="activity-empty">{empty}</li>}
        {rows.map((runs) => {
          const e = runs[0];
          const focused = focusOp === e.op;
          const pills: Pill[] = [{ text: e.kind }, { text: e.background ? 'background' : 'user' }];
          if (e.outcome === 'cancelled' || e.outcome === 'skipped') pills.push({ text: e.outcome });
          if (runs.length > 1) pills.push({ text: `×${runs.length}`, title: `${runs.length} identical runs since ${clockTime(runs[runs.length - 1].at)}` });
          const hasDetail = runs.length > 1 || !!e.command || !!e.message || e.remote.length > 0 || e.output.length > 0;
          return (
            <DebugRow
              key={`${e.op}-${e.at}`} className="activity-entry" dataOp={e.op} status={e.outcome} at={e.at} now={now}
              label={e.label || '(no repo)'} title={e.label || undefined} pills={pills} ms={e.durationMs}
              copy={() => allText(runs, now)}
              detail={hasDetail ? () => <ActivityDetail e={e} runs={runs} focused={focused} /> : null}
              defaultOpen={e.outcome === 'failed' || focused}
            />
          );
        })}
      </ol>
    </>
  );
}

/**
 * K101 + 1D R9: the one Debug modal. Tabs: Activity (the activity log) | Commands (the backend's
 * git commands) | Actions (what the user ran). The header holds Copy diagnostics, Open logs folder
 * and the Perf overlay toggle. Debug info, so every tab is a selectable timeline with Copy all.
 */
export function ActivityModal() {
  const open = useActivityUi((s) => s.open);
  const view = useActivityUi((s) => s.view);
  const focusCommandId = useActivityUi((s) => s.focusCommandId);
  const perf = useActivityUi((s) => s.perfOverlay);
  // The log folder, read each time the modal opens; null where there's no file logging (the harness).
  const [logsDir, setLogsDir] = useState<string | null>(null);
  const ref = useModalKeys<HTMLDivElement>(open, close);
  useEffect(() => {
    if (!open) return;
    let live = true;
    api.logsDir().then((d) => { if (live) setLogsDir(d); }, () => { if (live) setLogsDir(null); });
    return () => { live = false; };
  }, [open]);
  if (!open) return null;
  return (
    <div className="modal-backdrop" onPointerDown={close}>
      <div ref={ref} className="modal activity-modal" role="dialog" aria-modal="true" aria-label="Activity" onPointerDown={(e) => e.stopPropagation()}>
        <div className="activity-head">
          <div className="activity-tabs" role="tablist" aria-label="Debug views">
            {TABS.map(([id, label]) => (
              <button key={id} type="button" role="tab" id={`activity-tab-${id}`} aria-controls="activity-panel" aria-selected={view === id} className="activity-tab" onClick={() => useActivityUi.getState().setView(id)}>{label}</button>
            ))}
          </div>
          <button type="button" className="activity-tool" onClick={() => run('debug.copyDiagnostics', 'Copy diagnostics', copyDiagnostics)}><ClipboardCopy size={13} aria-hidden />Copy diagnostics</button>
          <button type="button" className="activity-tool" disabled={logsDir === null} onClick={() => run('debug.openLogsFolder', 'Open logs directory', openLogsFolder)}><FolderOpen size={13} aria-hidden />Open logs directory</button>
          <button type="button" className="activity-tool" aria-pressed={perf} onClick={() => run('debug.perfOverlay', 'Perf overlay', () => useActivityUi.getState().togglePerfOverlay())}><Gauge size={13} aria-hidden />Perf overlay</button>
          <button type="button" className="icon-button" aria-label="Close activity" autoFocus onClick={close}><X size={14} /></button>
        </div>
        <div className="activity-panel" role="tabpanel" id="activity-panel" aria-labelledby={`activity-tab-${view}`}>
          {view === 'activity' && <ActivityView />}
          {view === 'commands' && <CommandLogView focusId={focusCommandId} />}
          {view === 'actions' && <ActionLogView />}
        </div>
      </div>
    </div>
  );
}
