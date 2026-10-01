import { History } from 'lucide-react';
import { ActivityModal } from '../app/ActivityModal';
import { openActivityLog } from '../app/activityLog';
import { registerActions } from '../app/actions';
import { registerAppSlot } from '../app/slots';
import { StatusBar } from './StatusBar';

/** The status bar (spec §6.5), in the app's `statusBar` slot, below the tabs; and Help → Activity
 * log (K96), which opens from its bell. */
const offs = [
  registerAppSlot('statusBar', 'status-bar', StatusBar),
  registerAppSlot('overlay', 'activity.modal', ActivityModal),
  registerActions([
    { id: 'help.activityLog', label: 'Activity log', group: 'Help', icon: History, tooltip: 'Every finished fetch and clone, with git\'s message', run: openActivityLog },
  ]),
];
import.meta.hot?.dispose(() => { for (const off of offs) off(); });
