import { openFlyout } from '../../ui/flyout/flyout';

/** The Create flyout's key in 4B's flyout registry (T9 registers it) and its props. */
export const CREATE_MR_FLYOUT = 'createMr';
export interface CreateMrArgs { branch: string }

/** Opens the branch's Create flyout in the tab (one flyout per tab: it replaces the open one). */
export const openCreateMr = (tabId: string, branch: string): void => openFlyout<CreateMrArgs>(tabId, CREATE_MR_FLYOUT, { branch });
