import { activeTab, registerActions } from '../app/actions';
import { runFetch } from '../app/fetchSchedule';
import { useOps } from '../app/ops';
import type { RepoCtx } from '../app/repoContext';
import { registerTabSlot } from '../app/slots';
import { ICONS } from '../menu/icons';
import { registerToolbarButton } from './registry';
import { Toolbar } from './Toolbar';

/** The toolbar (spec §6.3) in each repo tab's `toolbar` slot, and its Fetch (spec §15). */
const repoTab = () => {
  const t = activeTab();
  return t?.kind === 'repo' && t.path ? t : null;
};

/** A fetch is running for the tab's repo (the user's or the background one). */
const useFetching = ({ repoId }: RepoCtx) => useOps((s) => Object.values(s.ops).some((o) => o.kind === 'fetch' && o.repo === repoId));

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
  registerToolbarButton({ action: 'repo.fetch', label: 'Fetch', order: 10, menu: ['repo.fetch'], useBusy: useFetching }),
  // Search (spec §6.3) runs find's `edit.find` (W3-D: the graph's FindBox, or Monaco's find while
  // a diff is open). Until that action is registered, no button renders (no placeholder UI).
  registerToolbarButton({ action: 'edit.find', label: 'Search', order: 20 }),
  registerTabSlot('toolbar', 'toolbar', Toolbar),
];
// A dev-server hot update re-runs this module: release the old registrations first.
import.meta.hot?.dispose(() => { for (const off of offs) off(); });
