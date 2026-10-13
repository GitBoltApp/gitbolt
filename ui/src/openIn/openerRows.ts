import type { LucideIcon } from 'lucide-react';
import type { OpenerPayload } from '../api/gen/OpenerPayload';
import type { BlobSource } from '../api/gen/BlobSource';
import { ICONS } from '../menu/icons';
import type { MenuRow } from '../menu/types';

// Pure (no API client, no stores): what an "Open in…" entry looks like, shared by the diff
// header's Open in button (OpenInMenu) and the file menu's Open in ▸ submenu.

/** The last used, else VS Code (spec §14.5), else the first editor, else the file manager, else
 * "Other…" (the default only once picked, or when nothing else is listed). Never the default
 * app: it stays a menu row, since what it does depends on the file. */
export function defaultOpener(list: OpenerPayload[], last: string | null): OpenerPayload | null {
  const usable = list.filter((o) => o.kind !== 'defaultApp');
  return usable.find((o) => o.id === last) ?? usable.find((o) => o.id === 'vscode') ?? usable.find((o) => o.kind === 'editor') ?? usable.find((o) => o.kind === 'fileManager') ?? usable[0] ?? null;
}

/** Whether `path` is a web page, whose default app is the browser. */
export const isHtml = (path: string | undefined) => !!path && /\.(html?|xhtml)$/i.test(path);

/** The extensions the core never opens in their default app, since the OS would run or launch
 * the file (`openers::default_app::PROGRAM_EXTENSIONS`; keep the two lists the same). The core
 * also refuses an executable file on Unix, and what Windows calls dangerous. */
const PROGRAM_EXTENSIONS = new Set([
  'exe', 'bat', 'cmd', 'com', 'scr', 'vbs', 'vbe', 'js', 'jse', 'wsf', 'wsh', 'hta', 'msi', 'msp', 'cpl', 'lnk', 'url', 'reg', 'jar', 'ps1', 'psm1', 'scf', 'pif',
  'application', 'appref-ms',
  'desktop', 'sh', 'bash', 'zsh', 'command', 'tool', 'terminal', 'app', 'appimage', 'run', 'fileloc', 'inetloc', 'webloc', 'scpt', 'applescript', 'workflow',
]);

/** Whether the OS would run `path` as a program, by its name (trailing dots and spaces dropped,
 * as Windows does). */
export function runsAsProgram(path: string | undefined): boolean {
  const name = (path ?? '').split('/').pop()!.replace(/[. ]+$/, '');
  const dot = name.lastIndexOf('.');
  return dot >= 0 && PROGRAM_EXTENSIONS.has(name.slice(dot + 1).toLowerCase());
}

/** Whether a diff target is a submodule (either side), which has no default app row. */
export const isSubmodule = (t: { old: BlobSource; new: BlobSource }) => t.old.kind === 'submodule' || t.new.kind === 'submodule';

/** Why the default app's row is disabled for such a file: the core's own refusal. */
export const RUNS_AS_PROGRAM = 'Runs as a program: open it in an editor, or use Other…';

/** An opener's label. The default app's names what it is for `path`: "Open in browser" for an
 * HTML file (still the system's handler for it), else "Open in default app". */
export const openerLabel = (o: OpenerPayload, path?: string) => {
  if (o.kind === 'defaultApp') return isHtml(path) ? 'Open in browser' : 'Open in default app';
  return o.kind === 'chooser' ? o.name : o.kind === 'fileManager' ? `Show in ${o.name}` : `Open in ${o.name}`;
};

export const openerIcon = (o: OpenerPayload, path?: string): LucideIcon => {
  if (o.kind === 'defaultApp') return isHtml(path) ? ICONS.webPage : ICONS.defaultApp;
  return o.kind === 'chooser' ? ICONS.openWith : o.kind === 'fileManager' ? ICONS.reveal : ICONS.editorApp;
};

/** An opener's menu row id (`initial` of the submenu names the default this way). */
export const openerRowId = (o: OpenerPayload) => `opener.${o.id}`;

/** What the rows open. `copy`: a stored version (spec §14.5), which opens as the file itself when
 * it hasn't changed since and as a read-only copy when it has, as the tooltips say. `folder`: a folder (only a file manager can show one). `submodule`: a submodule,
 * a folder too: no default app row. `path`: the file's path, which names the default app's row,
 * or disables it for a program. */
export interface OpenerRowsFor { copy?: boolean; folder?: boolean; submodule?: boolean; path?: string }

/**
 * One action row per opener, in the backend's order (editors, then the default app, the file
 * manager and "Other…").
 */
export function openerRows(list: OpenerPayload[], pick: (o: OpenerPayload) => void, { copy = false, folder = false, path }: OpenerRowsFor = {}): Extract<MenuRow, { kind: 'action' }>[] {
  const what = copy ? 'this version (the file, or a read-only copy if it has changed since)' : 'the file';
  const tooltip = (o: OpenerPayload) => {
    if (o.kind === 'fileManager') return folder ? `Show the directory in ${o.name}` : `Show the file's directory in ${o.name}`;
    // A copy is a temporary file: the app it opens in may not say so.
    if (o.kind === 'defaultApp') return `Open ${copy ? 'this version' : 'the file'} in ${isHtml(path) ? 'the default browser' : 'its default application'}${copy ? ': the file itself, or a temporary read-only copy if it has changed since' : ''}`;
    return o.kind === 'chooser' ? `Choose another application to open ${what} with` : `Open ${what} in ${o.name}`;
  };
  return list.map((o) => {
    const disabledReason = o.kind === 'defaultApp' && runsAsProgram(path) ? RUNS_AS_PROGRAM : undefined;
    return { kind: 'action', id: openerRowId(o), label: openerLabel(o, path), icon: openerIcon(o, path), tooltip: disabledReason ?? tooltip(o), run: () => pick(o), disabledReason };
  });
}

/**
 * The Open in ▸ submenu's rows: the openers, a separator before the default app, "Show in
 * Files" and "Other…"; or, before the first load (`list` null), a disabled loading row, or the
 * load's error. For a folder, the file managers only.
 */
export function openInSubmenuRows(all: OpenerPayload[] | null, error: string | null, pick: (o: OpenerPayload) => void, opts: OpenerRowsFor = {}): MenuRow[] {
  const list = all && opts.folder ? all.filter((o) => o.kind === 'fileManager') : all && opts.submodule ? all.filter((o) => o.kind !== 'defaultApp') : all;
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
