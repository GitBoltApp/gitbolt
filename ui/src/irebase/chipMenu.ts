import { RotateCcw, Trash2 } from 'lucide-react';
import { copyText } from '../api/transport';
import { ICONS } from '../menu/icons';
import type { MenuRow } from '../menu/types';
import { confirmAction } from '../ui/ConfirmDialog';
import { useToast } from '../ui/toast';
import { chipChange, deleteChip, revertChip } from './model';
import { editState, sessionOf } from './session';

/** The rebase editor's chip menu target (UX R1.3): the chip's branch in tab `tabId`'s editor.
 * The rebased branch's chip and the base's are read-only: they only copy. */
export interface ChipTarget { tabId: string; branch: string }

const short = (oid: string) => oid.slice(0, 7);

/** "Delete branch" (armed in place) and "Remove from this plan's changes" / "Restore". Moving the
 * chip is its drag. A locked chip, the rebased branch's and the base's get none. */
export function chipManageRows({ tabId, branch }: ChipTarget): MenuRow[] {
  const c = sessionOf(tabId)?.state.chips.find((x) => x.branch === branch);
  if (!c || c.locked) return [];
  const change = chipChange(c);
  const rows: MenuRow[] = [];
  if (change !== 'deleted') {
    const added = change === 'added';
    rows.push({
      kind: 'action', id: 'irebase.chip.delete', label: 'Delete branch', icon: Trash2,
      tooltip: added ? `Don't create ${branch}` : `Delete ${branch} once the rebase completes`,
      run: () => void (async () => {
        const ok = await confirmAction({
          title: `Delete ${branch}?`, body: added ? 'It is not created.' : 'It is deleted once the rebase completes.', confirmLabel: 'Delete',
          arm: added ? `Click again to drop ${branch}` : `Click again to delete ${branch}`, danger: true,
        });
        if (ok) editState(tabId, (s) => deleteChip(s, branch));
      })(),
    });
  }
  if (change === 'deleted') {
    rows.push({ kind: 'action', id: 'irebase.chip.revert', label: 'Restore', icon: RotateCcw, tooltip: `Keep ${branch}: it isn't deleted`, run: () => editState(tabId, (s) => revertChip(s, branch)) });
  } else if (change === 'moved') {
    rows.push({ kind: 'action', id: 'irebase.chip.revert', label: "Remove from this plan's changes", icon: RotateCcw, tooltip: `Put ${branch} back on ${short(c.origin!)}`, run: () => editState(tabId, (s) => revertChip(s, branch)) });
  }
  return rows;
}

/** "Copy branch name", on every chip. */
export function chipCopyRows({ branch }: ChipTarget): MenuRow[] {
  return [{
    kind: 'action', id: 'irebase.chip.copy', label: 'Copy branch name', icon: ICONS.copy, tooltip: `Copy "${branch}"`,
    run: () => { copyText(branch).then(() => useToast.getState().show('Copied'), () => useToast.getState().show('Copy failed')); },
  }];
}
