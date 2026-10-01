import { registerAppSlot } from '../app/slots';
import { StatusBar } from './StatusBar';

/** The status bar (spec §6.5), in the app's `statusBar` slot, below the tabs. */
const off = registerAppSlot('statusBar', 'status-bar', StatusBar);
import.meta.hot?.dispose(off);
