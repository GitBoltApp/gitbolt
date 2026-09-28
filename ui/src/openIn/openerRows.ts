import type { LucideIcon } from 'lucide-react';
import type { OpenerPayload } from '../api/gen/OpenerPayload';
import { ICONS } from '../menu/icons';
import type { MenuRow } from '../menu/types';

// Pure (no API client, no stores): what an "Open in…" entry looks like, shared by the diff
// header's Open in button (OpenInMenu) and the file menu's Open in ▸ submenu.

/** The last used, else VS Code (spec §14.5), else the first editor, else anything but "Other…",
 * else "Other…". */
export function defaultOpener(list: OpenerPayload[], last: string | null): OpenerPayload | null {
  return list.find((o) => o.id === last) ?? list.find((o) => o.id === 'vscode') ?? list.find((o) => o.kind === 'editor') ?? list.find((o) => o.kind !== 'chooser') ?? list[0] ?? null;
}

export const openerLabel = (o: OpenerPayload) => (o.kind === 'chooser' ? o.name : o.kind === 'fileManager' ? `Show in ${o.name}` : `Open in ${o.name}`);

export const openerIcon = (o: OpenerPayload): LucideIcon => (o.kind === 'chooser' ? ICONS.openWith : o.kind === 'fileManager' ? ICONS.reveal : ICONS.editorApp);

/** An opener's menu row id (`initial` of the submenu names the default this way). */
export const openerRowId = (o: OpenerPayload) => `opener.${o.id}`;

/** What the rows open. `copy`: a read-only copy of a stored version (spec §14.5), which the
 * tooltips say. `folder`: a folder (only a file manager can show one). */
export interface OpenerRowsFor { copy?: boolean; folder?: boolean }

/**
 * One action row per opener, in the backend's order (editors, then the file manager, then
 * "Other…").
 */
export function openerRows(list: OpenerPayload[], pick: (o: OpenerPayload) => void, { copy = false, folder = false }: OpenerRowsFor = {}): Extract<MenuRow, { kind: 'action' }>[] {
  const what = copy ? 'a read-only copy of this version' : 'the file';
  const tooltip = (o: OpenerPayload) => {
    if (o.kind === 'fileManager') return folder ? `Show the folder in ${o.name}` : `Show the file's folder in ${o.name}`;
    return o.kind === 'chooser' ? `Choose another application to open ${what} with` : `Open ${what} in ${o.name}`;
  };
  return list.map((o) => ({ kind: 'action', id: openerRowId(o), label: openerLabel(o), icon: openerIcon(o), tooltip: tooltip(o), run: () => pick(o) }));
}

/**
 * The Open in ▸ submenu's rows: the openers, a separator before "Show in Files"/"Other…"; or,
 * before the first load (`list` null), a disabled loading row, or the load's error. For a
 * folder, the file managers only.
 */
export function openInSubmenuRows(all: OpenerPayload[] | null, error: string | null, pick: (o: OpenerPayload) => void, opts: OpenerRowsFor = {}): MenuRow[] {
  const list = all && opts.folder ? all.filter((o) => o.kind === 'fileManager') : all;
  const status = (id: string, label: string, icon: LucideIcon, reason: string): MenuRow[] => [{ kind: 'action', id, label, icon, tooltip: reason, run: () => {}, disabledReason: reason }];
  if (list === null) {
    return error
      ? status('openers.error', "Couldn't list editors", ICONS.error, `Couldn't list editors: ${error}`)
      : status('openers.loading', 'Looking for editors…', ICONS.loading, 'Still looking for the installed editors');
  }
  if (list.length === 0) {
    return opts.folder
      ? status('openers.none', 'No file manager found', ICONS.error, 'No file manager was found on this machine')
      : status('openers.none', 'No editor or file manager found', ICONS.error, 'No editor or file manager was found on this machine');
  }
  const rows: MenuRow[] = openerRows(list, pick, opts);
  const firstOther = list.findIndex((o) => o.kind !== 'editor');
  if (firstOther > 0) rows.splice(firstOther, 0, { kind: 'separator' });
  return rows;
}
