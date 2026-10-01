import { registerTabSlot } from '../app/slots';
import { OpenRepoScreen } from './OpenRepoScreen';

/** The Open Repository screen (spec §13), the whole page of an Open tab (`openTab` slot). */
const off = registerTabSlot('openTab', 'open.screen', OpenRepoScreen);
import.meta.hot?.dispose(off);
