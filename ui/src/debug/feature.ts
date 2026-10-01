import { Bug } from 'lucide-react';
import { openDebug } from '../app/activityLog';
import { registerActions } from '../app/actions';
import { registerAppSlot } from '../app/slots';
import { setMenuRowRunner } from '../menu/menuStore';
import { runMenuRow } from './actionLog';
import { toastActionError } from './errorToast';
import { PerfOverlay } from './PerfOverlay';

/** Help → Debug… (R9: the Activity modal on its Commands tab; Help → Activity log stays), the perf
 * overlay, and the context menu's row-run hook feeding the action log (R11). */
const offs = [
  registerActions([
    { id: 'help.debug', label: 'Debug…', group: 'Help', icon: Bug, tooltip: 'The git commands GitBolt ran, the actions you ran, diagnostics and the perf overlay', run: () => openDebug('commands') },
  ]),
  registerAppSlot('overlay', 'debug.perfOverlay', PerfOverlay),
  setMenuRowRunner((id, label, run) => runMenuRow(id, label, run, (e) => {
    console.warn(`[gitbolt] menu row ${id} failed`, e);
    toastActionError(e);
  })),
];
import.meta.hot?.dispose(() => { for (const off of offs) off(); });
