import { Bell, BellOff, History, TriangleAlert } from 'lucide-react';
import { copyText } from '../api/transport';
import { openActivityLog } from '../app/activityLog';
import { useOps } from '../app/ops';
import { openMenuAt } from '../menu/menuStore';
import type { MenuRow } from '../menu/types';
import { HoverTooltip } from '../ui/HoverTooltip';
import { useToast } from '../ui/toast';

const BELL_ROWS = 20;
const BELL_LABEL = 80;

/** The bell's menu: the background error history, newest first (spec §16.1). A row copies its
 * message; its tooltip has the time and the whole message. */
function bellRows(): MenuRow[] {
  const { errors } = useOps.getState();
  // K96: the activity log (every finished fetch and clone, with git's message) is one step away.
  const activity: MenuRow = { kind: 'action', id: 'bell.activity', label: 'Activity log…', icon: History, tooltip: 'Every finished fetch and clone, background ones included', run: openActivityLog };
  if (errors.length === 0) return [{ kind: 'action', id: 'bell.none', label: 'No notifications', icon: BellOff, tooltip: 'Background errors (a failed background fetch) appear here', run: () => {}, disabledReason: 'Nothing to show' }, { kind: 'separator' }, activity];
  const rows: MenuRow[] = errors.slice(0, BELL_ROWS).map((e, i) => ({
    kind: 'action', id: `bell.${i}`, label: e.message.length > BELL_LABEL ? `${e.message.slice(0, BELL_LABEL - 1)}…` : e.message, icon: TriangleAlert,
    tooltip: `${new Date(e.at).toLocaleString()}\n${e.message}\n\nClick to copy`,
    run: () => { void copyText(e.message).then(() => useToast.getState().show('Copied'), () => useToast.getState().show('Copy failed')); },
  }));
  return [...rows, { kind: 'separator' }, activity, { kind: 'action', id: 'bell.clear', label: 'Clear notifications', icon: BellOff, tooltip: 'Forget these errors', run: () => useOps.getState().clearErrors() }];
}

/** The notification bell, in the tab bar left of the settings gear: an unread badge, and the menu
 * of background errors with the activity log. */
export function NotificationsBell() {
  const unread = useOps((s) => s.unread);
  return (
    <HoverTooltip content="Notifications: background errors">
      <button
        type="button"
        className="tab-bar-btn bell-btn"
        aria-label={`Notifications${unread ? ` (${unread} new)` : ''}`}
        aria-haspopup="menu"
        onClick={(e) => { openMenuAt(e.currentTarget, bellRows(), undefined, bellRows, 'Notifications'); useOps.getState().markRead(); }}
      >
        <Bell size={16} aria-hidden />{unread > 0 && <span className="bell-badge">{unread}</span>}
      </button>
    </HoverTooltip>
  );
}
