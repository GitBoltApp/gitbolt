import { registerAppSlot } from '../app/slots';
import { AuthModal } from './AuthModal';

/** The askpass prompt (spec §5.4), in the app's `overlay` slot: one for the whole app. */
const off = registerAppSlot('overlay', 'auth', AuthModal);
import.meta.hot?.dispose(off);
