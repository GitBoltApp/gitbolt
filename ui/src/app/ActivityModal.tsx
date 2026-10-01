import { Check, CircleSlash, Copy, TriangleAlert, X, type LucideIcon } from 'lucide-react';
import { useState } from 'react';
import { copyText } from '../api/transport';
import type { OpOutcome } from '../api/gen/OpOutcome';
import { useToast } from '../ui/toast';
import { allText, entryText, relativeTime, seconds, useActivityUi } from './activityLog';
import { useModalKeys } from './modalKeys';
import { useOps } from './ops';
import './activity.css';

const ICON: Record<OpOutcome, LucideIcon> = { ok: Check, failed: TriangleAlert, cancelled: CircleSlash, skipped: CircleSlash };

function copy(text: string) {
  void copyText(text).then(() => useToast.getState().show('Copied'), () => useToast.getState().show('Copy failed'));
}

/** K101: the activity log as a modal timeline, newest first; debug info, so all of it is selectable. */
export function ActivityModal() {
  const open = useActivityUi((s) => s.open);
  const activity = useOps((s) => s.activity);
  const [errorsOnly, setErrorsOnly] = useState(false);
  const close = () => useActivityUi.getState().setOpen(false);
  const ref = useModalKeys<HTMLDivElement>(open, close);
  if (!open) return null;
  const now = Date.now();
  const shown = errorsOnly ? activity.filter((e) => e.outcome === 'failed') : activity;
  return (
    <div className="modal-backdrop" onPointerDown={close}>
      <div ref={ref} className="modal activity-modal" role="dialog" aria-modal="true" aria-label="Activity" onPointerDown={(e) => e.stopPropagation()}>
        <div className="activity-head">
          <h2>Activity</h2>
          <label className="activity-filter"><input type="checkbox" checked={errorsOnly} onChange={(e) => setErrorsOnly(e.target.checked)} /> Errors only</label>
          <button type="button" className="activity-copy-all" disabled={shown.length === 0} onClick={() => copy(allText(shown, now))}>Copy all</button>
          <button type="button" className="icon-button" aria-label="Close activity" autoFocus onClick={close}><X size={14} /></button>
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
                  <button type="button" className="icon-button" aria-label="Copy entry" onClick={() => copy(entryText(e, now))}><Copy size={13} /></button>
                </div>
                {(e.command || e.message) && <pre className="activity-msg">{e.command && <span className="activity-cmd">$ {e.command}{e.message ? '\n' : ''}</span>}{e.message}</pre>}
              </li>
            );
          })}
        </ol>
      </div>
    </div>
  );
}
