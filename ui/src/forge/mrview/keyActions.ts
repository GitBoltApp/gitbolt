import { Check, ExternalLink, GitMerge, GitPullRequestArrow } from 'lucide-react';
import { registerActions } from '../../app/actions';
import { lentHandler } from '../../app/lent';
import { isTypingTarget } from '../../ui/keys';

/**
 * The open MR/PR view's main actions from the keyboard: Approve (Ctrl+Shift+A), Merge
 * (Ctrl+Shift+M), Open in browser (Ctrl+Shift+O) and the merge box's first branch update
 * (Ctrl+Alt+U: GitLab's Rebase, GitHub's Update branch). The view lends them while they apply
 * (`useMrActions`, `MergeBox`, `MrView`); Approve and Merge still ask first (a popover, as for
 * any confirm started from the keyboard); an update doesn't (nothing is lost: the forge keeps the
 * old head). Not while typing a comment.
 */
const lent = (id: string) => ({ when: () => lentHandler(id) !== null, run: () => lentHandler(id)?.(), yieldsTo: isTypingTarget });

const off = registerActions([
  { id: 'mr.approve', label: 'Approve the MR/PR', group: 'Repository', section: 'Merge request', icon: Check, tooltip: 'Approve the open merge request or pull request', shortcuts: ['Mod+Shift+A'], menu: false, ...lent('mr.approve') },
  { id: 'mr.merge', label: 'Merge the MR/PR', group: 'Repository', section: 'Merge request', icon: GitMerge, tooltip: 'Merge the open merge request or pull request', shortcuts: ['Mod+Shift+M'], menu: false, ...lent('mr.merge') },
  { id: 'mr.updateBranch', label: "Update the MR/PR's branch", group: 'Repository', section: 'Merge request', icon: GitPullRequestArrow, tooltip: "Rebase or update the open merge request's or pull request's branch with its target", shortcuts: ['Mod+Alt+U'], menu: false, ...lent('mr.updateBranch') },
  { id: 'mr.openInBrowser', label: 'Open the MR/PR in the browser', group: 'Repository', section: 'Merge request', icon: ExternalLink, tooltip: 'Open the open merge request or pull request on its forge', shortcuts: ['Mod+Shift+O'], menu: false, ...lent('mr.openInBrowser') },
]);
import.meta.hot?.dispose(off);
