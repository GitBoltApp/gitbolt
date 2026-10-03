import type { MenuRow } from '../menu/types';
import type { EditorContextMenuEvent } from './monaco/host';

// The open WIP diff's staging rows at the top of the editor's context menu (spec #2 §7.3): the
// shown diff's `HunkActions` provides them while it's mounted. A plain module, so the menu code
// reaches it without pulling the diff's chunk in.
type Provider = (e: EditorContextMenuEvent) => MenuRow[];
let current: Provider | null = null;

/** Installs `p`; the returned function removes it (unless another one replaced it since). */
export function provideStagingRows(p: Provider): () => void {
  current = p;
  return () => {
    if (current === p) current = null;
  };
}

/** The staging rows for a right-click in the diff editor; `[]` outside a WIP diff. */
export const stagingRows = (e: EditorContextMenuEvent): MenuRow[] => (e.side === 'file' ? [] : (current?.(e) ?? []));
