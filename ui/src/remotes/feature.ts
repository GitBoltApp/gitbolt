import { Plus } from 'lucide-react';
import { activeTab, registerActions } from '../app/actions';
import { registerSidebarHeaderAction } from '../sidebar/itemActions';
import { offAddRemoteDialog, openAddRemote } from './AddRemoteDialog';

/** Add remote (spec #4 §5): the Remote panel's +, and the palette. */
const offs = [
  offAddRemoteDialog,
  registerSidebarHeaderAction('remote', { id: 'remote.add', icon: Plus, label: 'Add remote', run: ({ tabId }) => openAddRemote(tabId) }),
  registerActions([{
    id: 'remote.add', label: 'Add remote…', group: 'Repository', icon: Plus, tooltip: "Add a remote by URL, or one of the project's forks",
    when: () => { const t = activeTab(); return t?.kind === 'repo' && !!t.path; },
    run: () => { const t = activeTab(); if (t) openAddRemote(t.id); },
  }]),
];
import.meta.hot?.dispose(() => { for (const off of offs) off(); });
