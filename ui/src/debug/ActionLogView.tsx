import { useMemo, useState } from 'react';
import { copyAndSay } from '../app/activityLog';
import { actionEntryText, actionLogText, useActionLog } from './actionLog';
import { DebugCheck, DebugRow } from './DebugRow';

/** The Debug modal's Actions tab (R11): what the user ran, newest first, one row each; a failure's
 * error is its expanded part, open by default. */
export function ActionLogView() {
  const entries = useActionLog((s) => s.entries);
  const [failedOnly, setFailedOnly] = useState(false);
  const shown = useMemo(() => (failedOnly ? entries.filter((e) => !e.ok) : entries).slice().reverse(), [entries, failedOnly]);
  const now = useMemo(() => Date.now(), [shown]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <>
      <div className="debug-toolbar">
        <DebugCheck label="Failed only" checked={failedOnly} onChange={setFailedOnly} />
        <span className="debug-count">{shown.length} of {entries.length}</span>
        <button type="button" className="activity-copy-all" disabled={shown.length === 0} onClick={() => void copyAndSay(actionLogText(shown, now))}>Copy all</button>
      </div>
      <ol className="activity-list">
        {shown.length === 0 && <li className="activity-empty">{failedOnly ? 'No failures' : 'No actions yet: every menu, palette, shortcut and toolbar action appears here'}</li>}
        {shown.map((e) => (
          <DebugRow
            key={e.seq} className="debug-entry" status={e.ok ? 'ok' : 'failed'} at={e.at} now={now}
            label={e.label} title={e.label} pills={[{ text: e.id, mono: true }, { text: e.source }]} ms={e.ms}
            copy={() => actionEntryText(e, now)}
            detail={e.error ? () => <pre className="debug-err">{e.error}</pre> : null}
            defaultOpen={!e.ok}
          />
        ))}
      </ol>
    </>
  );
}
