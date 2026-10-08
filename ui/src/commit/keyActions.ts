import { GitCommitHorizontal } from 'lucide-react';
import { registerActions } from '../app/actions';
import { lentHandler } from '../app/lent';
import { isTypingTarget } from '../ui/keys';

/**
 * Ctrl+Enter commits from anywhere the WIP's commit box shows (the file list, the diff), as it
 * already did in the message (`CommitFields`). It leaves the chord to whatever types (another
 * text box, the editable working copy, where it's Monaco's "insert line below") and to dialogs,
 * whose own Ctrl+Enter submits them. The box lends what its button does (`CommitBox`): commit,
 * or with nothing to commit yet, put the keyboard in the message and say why.
 */
const off = registerActions([
  {
    id: 'commit.commit', label: 'Commit', group: 'Repository', section: 'Commit message', icon: GitCommitHorizontal, tooltip: 'Commit with the message in the commit box', shortcuts: ['Mod+Enter'], menu: false,
    when: () => lentHandler('commit.commit') !== null,
    yieldsTo: (t) => isTypingTarget(t) || (t instanceof Element && t.closest('[role="dialog"]') !== null),
    run: () => lentHandler('commit.commit')?.(),
  },
]);
import.meta.hot?.dispose(off);
