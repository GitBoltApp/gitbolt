import { ArrowLeft, ArrowRight } from 'lucide-react';
import { activeTab, registerActions } from '../app/actions';
import { navBack, navForward } from './history';
import { installNavInput } from './input';

/** Spec #5 §3.4, §5: Go back / Go forward, in the palette and the shortcuts panel. Usable in any
 * repository tab, so they always list; with nowhere to go they do nothing. Their `shortcuts` are
 * display names: `input.ts` handles the keys and buttons (the Ctrl dispatcher never matches them). */
const inRepoTab = () => activeTab()?.kind === 'repo';
const offActions = registerActions([
  {
    id: 'nav.back',
    label: 'Go back',
    group: 'View',
    icon: ArrowLeft,
    tooltip: 'Back to the previous MR/PR, file or commit you visited',
    shortcuts: ['Alt+Left', 'Mouse back'],
    when: inRepoTab,
    run: () => {
      const t = activeTab();
      if (t) return navBack(t.id);
    },
  },
  {
    id: 'nav.forward',
    label: 'Go forward',
    group: 'View',
    icon: ArrowRight,
    tooltip: 'Forward to the next MR/PR, file or commit you visited',
    shortcuts: ['Alt+Right', 'Mouse forward'],
    when: inRepoTab,
    run: () => {
      const t = activeTab();
      if (t) return navForward(t.id);
    },
  },
]);
const offInput = installNavInput();

import.meta.hot?.dispose(() => {
  offActions();
  offInput();
});
