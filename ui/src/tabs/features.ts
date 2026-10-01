/**
 * The tab bar feature (ruling R10): the `header` app slot (the tab bar itself) and the `overlay`
 * slot's About dialog (the profile dialog renders from `ProfileSwitcher` directly, since it's
 * always mounted alongside it). Importing this module is what registers the tab context menu
 * (`tabMenu.ts`, imported for its side effect through `TabBar.tsx`).
 */
import { About } from '../app/About';
import { registerAppSlot } from '../app/slots';
import { TabBar } from './TabBar';

const offs = [
  registerAppSlot('header', 'tabs.tabBar', TabBar),
  registerAppSlot('overlay', 'tabs.about', About),
];
// A dev-server hot update re-runs this module: release the old registrations first.
import.meta.hot?.dispose(() => offs.forEach((off) => off()));
