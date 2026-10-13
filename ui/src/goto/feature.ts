import { ClipboardPaste } from 'lucide-react';
import { registerActions } from '../app/actions';
import { useAppState } from '../app/state';
import { isTypingOrEditor } from '../ui/keys';
import { gotoClipboard } from './run';

/**
 * Paste anywhere to go to it: Ctrl+V (Cmd+V) outside a text field or editor reads the clipboard
 * and goes to the commit, MR/PR, forge page, file, folder or branch it names (`classify.ts`,
 * `resolve.ts`, `run.ts`). A text field or any Monaco editor keeps the key (a read-only one does
 * nothing with it, as before); an open menu or dialog takes it first (the key router's layers).
 */
const off = registerActions([
  {
    id: 'edit.gotoClipboard', label: "Go to what's on the clipboard", group: 'Edit', icon: ClipboardPaste,
    tooltip: 'Go to the commit, merge request, file or branch the clipboard names', shortcuts: ['Mod+V'],
    when: () => useAppState.getState().profile.tabs.some((t) => t.kind === 'repo'),
    yieldsTo: isTypingOrEditor,
    repeats: false,
    run: gotoClipboard,
  },
]);
import.meta.hot?.dispose(off);
