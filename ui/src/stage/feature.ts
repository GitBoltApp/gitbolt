import { activeStore, activeTab } from '../app/actions';
import { comboOf } from '../app/shortcuts';
import { registerKeys, type KeyHandler } from '../ui/keyRouter';
import { isEditableTarget } from '../ui/keys';
import { stagingRedo, stagingUndo } from './actions';
import { resolveChord } from '../ui/platformKeys';

/**
 * Spec #2 §7.6: Ctrl+Z / Ctrl+Shift+Z with focus in the diff view or the WIP file list are
 * staging undo/redo (2A's `edit.undo` yields there, `ownsUndo`). A read-only Monaco counts as the
 * diff view. Editing the working copy (a focused, editable Monaco: `data-editable="true"`, T11)
 * keeps Monaco's own undo, and a text box keeps its own.
 */
export function stagingKeyTarget(target: EventTarget | null): boolean {
  const el = target instanceof Element ? target : null;
  if (!el) return false;
  if (el.closest('.monaco-editor')) {
    if (el.closest('[data-editable="true"]')) return false;
  } else if (isEditableTarget(el)) return false;
  return !!el.closest('.diff-panel, .wip-sections');
}

export const stagingKeys: KeyHandler = (e) => {
  const combo = comboOf(e);
  if ((combo !== resolveChord('Mod+Z') && combo !== resolveChord('Mod+Shift+Z')) || !stagingKeyTarget(e.target)) return;
  const tab = activeTab();
  const s = activeStore()?.getState();
  const sel = s?.panel?.selection;
  if (!tab || !s || sel?.kind !== 'wip') return;
  e.preventDefault();
  const ctx = { tabId: tab.id, repoId: s.repo, worktree: sel.worktree };
  void (combo === resolveChord('Mod+Z') ? stagingUndo(ctx) : stagingRedo(ctx));
  return 'handled';
};

const off = registerKeys('app', stagingKeys);
import.meta.hot?.dispose(off);
