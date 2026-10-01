import { Bell, BellOff, Check, LoaderCircle, TriangleAlert, ZoomIn } from 'lucide-react';
import { useEffect } from 'react';
import { api } from '../api/client';
import { copyText } from '../api/transport';
import { useAppInfo } from '../app/appInfo';
import { useOps } from '../app/ops';
import { useRuntime } from '../app/runtime';
import { useAppState } from '../app/state';
import { openMenuAt } from '../menu/menuStore';
import type { MenuRow } from '../menu/types';
import { HoverTooltip } from '../ui/HoverTooltip';
import { useToast } from '../ui/toast';
import { setZoom, useZoom, ZOOM_STEPS } from '../ui/zoom';
import './statusbar.css';

const BELL_ROWS = 20;
const BELL_LABEL = 80;

/** The bell's menu: the background error history, newest first (spec §16.1). A row copies its
 * message; its tooltip has the time and the whole message. */
function bellRows(): MenuRow[] {
  const { errors } = useOps.getState();
  if (errors.length === 0) return [{ kind: 'action', id: 'bell.none', label: 'No notifications', icon: BellOff, tooltip: 'Background errors (a failed background fetch) appear here', run: () => {}, disabledReason: 'Nothing to show' }];
  const rows: MenuRow[] = errors.slice(0, BELL_ROWS).map((e, i) => ({
    kind: 'action', id: `bell.${i}`, label: e.message.length > BELL_LABEL ? `${e.message.slice(0, BELL_LABEL - 1)}…` : e.message, icon: TriangleAlert,
    tooltip: `${new Date(e.at).toLocaleString()}\n${e.message}\n\nClick to copy`,
    run: () => { void copyText(e.message).then(() => useToast.getState().show('Copied'), () => useToast.getState().show('Copy failed')); },
  }));
  return [...rows, { kind: 'separator' }, { kind: 'action', id: 'bell.clear', label: 'Clear notifications', icon: BellOff, tooltip: 'Forget these errors', run: () => useOps.getState().clearErrors() }];
}

/** Spec §12.3: the zoom steps, the current one first in focus. */
function zoomRows(current: number): MenuRow[] {
  return ZOOM_STEPS.map((z) => ({
    kind: 'action', id: `zoom.${z}`, label: `${z}%`, icon: z === current ? Check : ZoomIn,
    tooltip: z === current ? 'The current zoom' : `Zoom to ${z}%`, shortcut: z === 100 ? 'Ctrl+0' : undefined, run: () => setZoom(z),
  }));
}

/** The running network op the bar shows: the first one (rarely more than one runs). */
const firstOp = (ops: ReturnType<typeof useOps.getState>['ops']) => Object.values(ops)[0];

/**
 * The status bar (spec §6.5), in the app's `statusBar` slot: zoom, the running fetch or clone
 * (or the auth prompt it waits on) with Cancel, the active tab's fetch-skipped warning, the
 * notification bell (background errors), and the git version.
 */
export function StatusBar() {
  const zoom = useZoom((s) => s.zoom);
  const activeTab = useAppState((s) => s.profile.activeTab);
  const skipped = useRuntime((s) => (activeTab ? s.tabs[activeTab]?.fetchSkipped ?? null : null));
  const task = useOps((s) => firstOp(s.ops));
  const prompt = useOps((s) => s.prompts[0]);
  const unread = useOps((s) => s.unread);
  const git = useAppInfo((s) => s.info?.gitVersion);
  useEffect(() => { void useAppInfo.getState().load().catch((e: unknown) => console.warn('[gitbolt] app info', e)); }, []);
  const cancel = (op: number) => { void api.cancelOp(op).catch(() => {}); };
  return (
    <footer className="status-bar">
      <HoverTooltip content="Zoom (Ctrl+= / Ctrl+-)">
        <button type="button" className="sb-item sb-button" aria-label={`Zoom ${zoom}%`} aria-haspopup="menu" onClick={(e) => openMenuAt(e.currentTarget, zoomRows(zoom), `zoom.${zoom}`, undefined, 'Zoom')}>
          {zoom}%
        </button>
      </HoverTooltip>
      {prompt ? (
        <span className="sb-item sb-auth">
          Waiting for authentication…
          <button type="button" className="sb-link" onClick={() => cancel(prompt.op)}>Cancel</button>
        </span>
      ) : task ? (
        <span className="sb-item sb-task">
          <LoaderCircle size={12} className="sb-spin" aria-hidden />
          {task.kind === 'fetch' ? 'Fetching…' : `Cloning…${task.percent !== null ? ` ${task.percent}%` : ''}`}
          <button type="button" className="sb-link" onClick={() => cancel(task.op)}>Cancel</button>
        </span>
      ) : null}
      {skipped && <span className="sb-item sb-warn"><TriangleAlert size={12} aria-hidden /> {skipped}</span>}
      <span className="sb-spacer" />
      <HoverTooltip content="Notifications: background errors">
        <button
          type="button"
          className="sb-item sb-button"
          aria-label={`Notifications${unread ? ` (${unread} new)` : ''}`}
          aria-haspopup="menu"
          onClick={(e) => { openMenuAt(e.currentTarget, bellRows(), undefined, bellRows, 'Notifications'); useOps.getState().markRead(); }}
        >
          <Bell size={12} aria-hidden />{unread > 0 && <span className="sb-badge">{unread}</span>}
        </button>
      </HoverTooltip>
      <span className="sb-item">git {git ?? '…'}</span>
    </footer>
  );
}
