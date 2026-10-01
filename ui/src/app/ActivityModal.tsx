import { Check, CircleSlash, ClipboardCopy, Copy, FolderOpen, Gauge, TriangleAlert, X, type LucideIcon } from 'lucide-react';
import { useEffect, useState } from 'react';
import { api } from '../api/client';
import type { OpOutcome } from '../api/gen/OpOutcome';
import { track } from '../debug/actionLog';
import { ActionLogView } from '../debug/ActionLogView';
import { CommandLogView } from '../debug/CommandLogView';
import { copyDiagnostics, openLogsFolder } from '../debug/diagnostics';
import { toastActionError } from '../debug/errorToast';
import { allText, copyAndSay, entryText, relativeTime, seconds, useActivityUi, type DebugView } from './activityLog';
import { useModalKeys } from './modalKeys';
import { useOps } from './ops';
import './activity.css';

const ICON: Record<OpOutcome, LucideIcon> = { ok: Check, failed: TriangleAlert, cancelled: CircleSlash, skipped: CircleSlash };
const TABS: Array<[DebugView, string]> = [['activity', 'Activity'], ['commands', 'Commands'], ['actions', 'Actions']];

/** Stable (R25, the N1 lesson): the modal-keys registration never re-runs for a new `close`. */
const close = () => useActivityUi.getState().setOpen(false);
/** A header button's work, recorded in the action log; a failure toasts like any action's (R12). */
const run = (id: string, label: string, fn: () => unknown) => track(id, label, fn, (e) => toastActionError(e));

/** K101's timeline: every finished fetch and clone, newest first. */
function ActivityView() {
  const activity = useOps((s) => s.activity);
  const [errorsOnly, setErrorsOnly] = useState(false);
  const now = Date.now();
  const shown = errorsOnly ? activity.filter((e) => e.outcome === 'failed') : activity;
  return (
    <>
      <div className="debug-toolbar">
        <label className="activity-filter"><input type="checkbox" checked={errorsOnly} onChange={(e) => setErrorsOnly(e.target.checked)} /> Errors only</label>
        <span className="debug-count" />
        <button type="button" className="activity-copy-all" disabled={shown.length === 0} onClick={() => void copyAndSay(allText(shown, now))}>Copy all</button>
      </div>
      <ol className="activity-list">
        {shown.length === 0 && <li className="activity-empty">{errorsOnly ? 'No failures' : 'No activity yet: every finished fetch and clone appears here'}</li>}
        {shown.map((e, i) => {
          const Icon = ICON[e.outcome];
          return (
            <li key={`${e.at}-${i}`} className={`activity-entry ${e.outcome}`}>
              <div className="activity-meta">
                <Icon size={14} aria-hidden />
                <span className="activity-time">{new Date(e.at).toLocaleString()} · {relativeTime(e.at, now)}</span>
                <span>{e.label || '(no repo)'}</span>
                <span>{e.kind}</span>
                <span>{e.background ? 'background' : 'user'}</span>
                <span>{seconds(e.durationMs)}</span>
                <span className="activity-result">{e.outcome}</span>
                <button type="button" className="icon-button" aria-label="Copy entry" onClick={() => void copyAndSay(entryText(e, now))}><Copy size={13} /></button>
              </div>
              {(e.command || e.message) && <pre className="activity-msg">{e.command && <span className="activity-cmd">$ {e.command}{e.message ? '\n' : ''}</span>}{e.message}</pre>}
            </li>
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
          <button type="button" className="activity-tool" disabled={logsDir === null} onClick={() => run('debug.openLogsFolder', 'Open logs folder', openLogsFolder)}><FolderOpen size={13} aria-hidden />Open logs folder</button>
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
