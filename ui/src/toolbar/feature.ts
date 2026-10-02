import type { SyncButtonMode } from '../api/gen/SyncButtonMode';
import { activeTab, registerActions } from '../app/actions';
import { runFetch } from '../app/fetchSchedule';
import { isShownFetch, useOps } from '../app/ops';
import { useRuntime } from '../app/runtime';
import { registerTabSlot } from '../app/slots';
import { useAppState } from '../app/state';
import { ICONS } from '../menu/icons';
import { useQueuedKind } from '../queue/store';
import { MODE_OF, pull, syncView } from '../sync/pull';
import { branchOf, headBranchOf } from '../sync/push';
import { writeCtx } from '../write/ctx';
import { registerToolbarButton } from './registry';
import { Toolbar } from './Toolbar';

/** The toolbar (spec §6.3) in each repo tab's `toolbar` slot, and its Fetch (spec §15). */
const repoTab = () => {
  const t = activeTab();
  return t?.kind === 'repo' && t.path ? t : null;
};

const offs = [
  registerActions([
    {
      id: 'repo.fetch', label: 'Fetch all', group: 'Repository', icon: ICONS.fetch, tooltip: 'Fetch every remote of the current repository',
      when: () => !!repoTab(),
      run: () => {
        const t = repoTab();
        return t ? runFetch(t.id, false) : undefined;
      },
    },
  ]),
  // --- 2D T19: the Fetch/Pull split button; `repo.fetch` stays for the palette ---
  registerActions([{
    id: 'repo.syncDefault', label: 'Fetch', group: 'Repository', icon: ICONS.fetch, tooltip: 'Fetch every remote',
    when: () => !!repoTab(),
    run: () => {
      const t = repoTab();
      if (!t) return;
      const mode = useAppState.getState().settings.syncButton;
      if (mode === 'fetchAll') return runFetch(t.id, false);
      const ctx = writeCtx(t.id);
      return ctx ? pull(ctx, MODE_OF[mode]) : undefined;
    },
  }]),
  registerToolbarButton({
    action: 'repo.syncDefault', order: 10,
    picker: {
      title: 'Select a default pull/fetch operation to execute when clicking this button',
      options: [
        { value: 'fetchAll', label: 'Fetch All' },
        { value: 'pullFfOrMerge', label: 'Pull (fast-forward if possible)' },
        { value: 'pullFfOnly', label: 'Pull (fast-forward only)' },
        { value: 'pullRebase', label: 'Pull (rebase)' },
      ],
      useValue: () => useAppState((s) => s.settings.syncButton),
      set: (v) => useAppState.getState().setSettings({ syncButton: v as SyncButtonMode }),
    },
    useView: ({ tabId }) => {
      const mode = useAppState((s) => s.settings.syncButton);
      const head = useRuntime(() => headBranchOf(tabId));
      const b = useRuntime(() => branchOf(tabId, head));
      const loaded = useRuntime((s) => !!s.tabs[tabId]?.sidebar && !!s.tabs[tabId]?.graph);
      if (mode !== 'fetchAll' && !loaded) return { label: 'Pull', tooltip: 'Loading…', disabled: true };
      return syncView(mode, b, head);
    },
    useBusy: ({ repoId }) => useOps((s) => Object.values(s.ops).some((o) => isShownFetch(o, repoId) || (o.kind === 'pull' && o.repo === repoId))),
    useQueued: ({ repoId }) => {
      const fetching = useQueuedKind(repoId, 'fetch');
      const pulling = useQueuedKind(repoId, 'pull');
      return fetching || pulling;
    },
  }),
  // --- end 2D T19 ---
  // Search (spec §6.3) runs find's `edit.find` (W3-D: the graph's FindBox, or Monaco's find while
  // a diff is open). Until that action is registered, no button renders (no placeholder UI).
  registerToolbarButton({ action: 'edit.find', label: 'Search', placement: 'end', order: 20 }),
  registerTabSlot('toolbar', 'toolbar', Toolbar),
];
// A dev-server hot update re-runs this module: release the old registrations first.
import.meta.hot?.dispose(() => { for (const off of offs) off(); });
