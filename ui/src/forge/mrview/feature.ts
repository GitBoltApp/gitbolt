import { lazy } from 'react';
import { registerFlyout } from '../../ui/flyout/flyout';
import { MR_FLYOUT, type MrViewArgs } from '../mrStore';

// Lazy: the view stays out of the startup chunk until an MR/PR is opened.
const MrView = lazy(() => import('./MrView').then((m) => ({ default: m.MrView })));
// Dockable: it can sit beside the graph instead of over it.
const off = registerFlyout<MrViewArgs>(MR_FLYOUT, MrView, { dockable: true });
import.meta.hot?.dispose(off);
