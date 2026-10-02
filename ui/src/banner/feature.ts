import { registerTabSlot } from '../app/slots';
import { Banners } from './Banners';

/** The `banner` slot's notices (spec #2 §6.4). */
const off = registerTabSlot('banner', 'banners', Banners);
import.meta.hot?.dispose(off);
