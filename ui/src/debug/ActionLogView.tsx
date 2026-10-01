import { Check, Copy, TriangleAlert } from 'lucide-react';
import { useMemo, useState } from 'react';
import { copyAndSay, relativeTime, seconds } from '../app/activityLog';
import { actionEntryText, actionLogText, useActionLog } from './actionLog';

/** The Debug modal's Actions tab (R11): what the user ran, newest first, as a selectable timeline. */
export function ActionLogView() {
  const entries = useActionLog((s) => s.entries);
  const [failedOnly, setFailedOnly] = useState(false);
  const shown = useMemo(() => (failedOnly ? entries.filter((e) => !e.ok) : entries).slice().reverse(), [entries, failedOnly]);
  const now = useMemo(() => Date.now(), [shown]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <>
      <div className="debug-toolbar">
        <label className="activity-filter"><input type="checkbox" checked={failedOnly} onChange={(e) => setFailedOnly(e.target.checked)} /> Failed only</label>
        <span className="debug-count">{shown.length} of {entries.length}</span>
        <button type="button" className="activity-copy-all" disabled={shown.length === 0} onClick={() => void copyAndSay(actionLogText(shown, now))}>Copy all</button>
      </div>
      <ol className="activity-list">
        {shown.length === 0 && <li className="activity-empty">{failedOnly ? 'No failures' : 'No actions yet: every menu, palette, shortcut and toolbar action appears here'}</li>}
        {shown.map((e) => {
          const Icon = e.ok ? Check : TriangleAlert;
          return (
            <li key={e.seq} className={`debug-entry${e.ok ? '' : ' failed'}`}>
              <div className="activity-meta">
                <Icon size={14} aria-hidden />
                <span className="activity-time">{new Date(e.at).toLocaleString()} · {relativeTime(e.at, now)}</span>
                <span>{e.label}</span>
                <span className="debug-id">{e.id}</span>
                <span>{e.source}</span>
                <span>{seconds(e.ms)}</span>
                <span className="activity-result">{e.ok ? 'ok' : 'failed'}</span>
                <button type="button" className="icon-button" aria-label="Copy entry" onClick={() => void copyAndSay(actionEntryText(e, now))}><Copy size={13} /></button>
              </div>
              {e.error && <pre className="activity-msg">{e.error}</pre>}
            </li>
          );
        })}
      </ol>
    </>
  );
}
