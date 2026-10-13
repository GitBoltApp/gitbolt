import { describe, expect, it, vi } from 'vitest';
import type { OpenerPayload } from '../api/gen/OpenerPayload';
import { ICONS } from '../menu/icons';
import type { MenuRow } from '../menu/types';
import { defaultOpener, isHtml, isSubmodule, openerIcon, openerLabel, openInSubmenuRows, runsAsProgram } from './openerRows';

const DEFAULT_APP: OpenerPayload = { id: 'default-app', name: 'Default app', kind: 'defaultApp' };
const OPENERS: OpenerPayload[] = [
  { id: 'vscode', name: 'VS Code', kind: 'editor' },
  DEFAULT_APP,
  { id: 'file-manager', name: 'Files', kind: 'fileManager' },
  { id: 'other', name: 'Other…', kind: 'chooser' },
];

const action = (rows: MenuRow[], label: string) => rows.find((r) => r.kind === 'action' && r.label === label) as Extract<MenuRow, { kind: 'action' }>;
const labels = (rows: MenuRow[]) => rows.map((r) => (r.kind === 'separator' ? '---' : r.kind === 'action' ? r.label : r.kind));

describe('Open in default app', () => {
  it('is "Open in browser" for an HTML file, else "Open in default app"', () => {
    for (const p of ['site/index.html', 'a.HTM', 'doc.xhtml']) {
      expect(isHtml(p)).toBe(true);
      expect(openerLabel(DEFAULT_APP, p)).toBe('Open in browser');
      expect(openerIcon(DEFAULT_APP, p)).toBe(ICONS.webPage);
    }
    for (const p of ['src/app.php', 'html/readme.md', 'page.html.twig', 'shtml', undefined]) {
      expect(isHtml(p)).toBe(false);
      expect(openerLabel(DEFAULT_APP, p)).toBe('Open in default app');
      expect(openerIcon(DEFAULT_APP, p)).toBe(ICONS.defaultApp);
    }
    // Other openers' labels don't depend on the file.
    expect(openerLabel(OPENERS[0], 'index.html')).toBe('Open in VS Code');
  });

  it('is listed after the editors, before Show in Files, and opens the file it was built for', () => {
    const pick = vi.fn();
    const rows = openInSubmenuRows(OPENERS, null, pick, { path: 'docs/index.html' });
    expect(labels(rows)).toEqual(['Open in VS Code', '---', 'Open in browser', 'Show in Files', 'Other…']);
    action(rows, 'Open in browser').run();
    expect(pick).toHaveBeenCalledWith(DEFAULT_APP);
    expect(labels(openInSubmenuRows(OPENERS, null, pick, { path: 'src/app.php' }))).toEqual(['Open in VS Code', '---', 'Open in default app', 'Show in Files', 'Other…']);
    // Not for a folder: its default app is the file manager, which "Show in" already is.
    expect(labels(openInSubmenuRows(OPENERS, null, pick, { folder: true, path: 'src' }))).toEqual(['Show in Files']);
  });

  it('says when it opens a temporary copy of an older version', () => {
    const working = openInSubmenuRows(OPENERS, null, () => {}, { path: 'src/app.php' });
    expect(action(working, 'Open in default app').tooltip).toBe('Open the file in its default application');
    const old = openInSubmenuRows(OPENERS, null, () => {}, { path: 'src/app.php', copy: true });
    expect(action(old, 'Open in default app').tooltip).toBe('Open this version in its default application: the file itself, or a temporary read-only copy if it has changed since');
    const oldPage = openInSubmenuRows(OPENERS, null, () => {}, { path: 'index.html', copy: true });
    expect(action(oldPage, 'Open in browser').tooltip).toBe('Open this version in the default browser: the file itself, or a temporary read-only copy if it has changed since');
  });

  it('is never the default opener: it stays a menu row', () => {
    expect(defaultOpener(OPENERS, null)?.id).toBe('vscode');
    expect(defaultOpener(OPENERS.slice(1), null)?.id).toBe('file-manager');
    // With no editor or file manager, "Other…" rather than the default app.
    expect(defaultOpener([DEFAULT_APP, OPENERS[3]], null)?.id).toBe('other');
    // A pick remembered by an earlier version is passed over.
    expect(defaultOpener(OPENERS, 'default-app')?.id).toBe('vscode');
    expect(defaultOpener([DEFAULT_APP], 'default-app')).toBeNull();
  });

  it('is disabled for a file the OS would run, saying why', () => {
    for (const p of ['setup.exe', 'tools/Install.SH', 'run.desktop', 'evil.bat. ', 'app.AppImage', 'Go.command']) {
      expect(runsAsProgram(p)).toBe(true);
      const row = action(openInSubmenuRows(OPENERS, null, () => {}, { path: p }), 'Open in default app');
      expect(row.disabledReason).toBe('Runs as a program: open it in an editor, or use Other…');
      expect(row.tooltip).toBe(row.disabledReason);
    }
    for (const p of ['README.md', 'exe', '.bashrc', 'a.sh.txt', 'src/app.php']) expect(runsAsProgram(p)).toBe(false);
    expect(action(openInSubmenuRows(OPENERS, null, () => {}, { path: 'src/app.php' }), 'Open in default app').disabledReason).toBeUndefined();
    // Other openers stay usable for it.
    expect(action(openInSubmenuRows(OPENERS, null, () => {}, { path: 'setup.exe' }), 'Other…').disabledReason).toBeUndefined();
  });

  it('has no row for a submodule (a folder)', () => {
    expect(labels(openInSubmenuRows(OPENERS, null, () => {}, { submodule: true, path: 'vendor/lib' }))).toEqual(['Open in VS Code', '---', 'Show in Files', 'Other…']);
    expect(isSubmodule({ old: { kind: 'submodule', oid: 'a'.repeat(40) }, new: { kind: 'absent' } })).toBe(true);
    expect(isSubmodule({ old: { kind: 'object', oid: 'a'.repeat(40) }, new: { kind: 'worktree', worktree: '/w' } })).toBe(false);
  });
});
