import { Check, ExternalLink, GitMerge } from 'lucide-react';
import { registerActions } from '../../app/actions';
import { lentHandler } from '../../app/lent';
import { isTypingTarget } from '../../ui/keys';

/**
 * The open MR/PR view's main actions from the keyboard: Approve (Ctrl+Shift+A), Merge
 * (Ctrl+Shift+M) and Open in browser (Ctrl+Shift+O). The view lends them while they apply
 * (`useMrActions`, `MergeBox`, `MrView`); Approve and Merge still ask first (a popover, as for
 * any confirm started from the keyboard). Not while typing a comment.
 */
const lent = (id: string) => ({ when: () => lentHandler(id) !== null, run: () => lentHandler(id)?.(), yieldsTo: isTypingTarget });

const off = registerActions([
  { id: 'mr.approve', label: 'Approve the MR/PR', group: 'Repository', section: 'Merge request', icon: Check, tooltip: 'Approve the open merge request or pull request', shortcuts: ['Ctrl+Shift+A'], menu: false, ...lent('mr.approve') },
  { id: 'mr.merge', label: 'Merge the MR/PR', group: 'Repository', section: 'Merge request', icon: GitMerge, tooltip: 'Merge the open merge request or pull request', shortcuts: ['Ctrl+Shift+M'], menu: false, ...lent('mr.merge') },
  { id: 'mr.openInBrowser', label: 'Open the MR/PR in the browser', group: 'Repository', section: 'Merge request', icon: ExternalLink, tooltip: 'Open the open merge request or pull request on its forge', shortcuts: ['Ctrl+Shift+O'], menu: false, ...lent('mr.openInBrowser') },
]);
import.meta.hot?.dispose(off);
