import { FolderOpen, Info } from 'lucide-react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MenuRow } from '../menu/types';
import { actionForCombo, availableActions, hamburgerRows, registerActions, runAction } from './actions';

describe('action registry', () => {
  const offs: Array<() => void> = [];
  afterEach(() => { offs.splice(0).forEach((f) => f()); });

  it('finds actions by shortcut, honours `when`, and runs them', () => {
    const run = vi.fn();
    let enabled = false;
    offs.push(registerActions([{ id: 'x.open', label: 'Open', group: 'File', icon: FolderOpen, tooltip: 'Open', shortcuts: ['Ctrl+O'], when: () => enabled, run }]));
    expect(actionForCombo('Ctrl+O')).toBeUndefined();
    expect(runAction('x.open')).toBe(false);
    enabled = true;
    expect(actionForCombo('Ctrl+O')?.id).toBe('x.open');
    expect(runAction('x.open')).toBe(true);
    expect(run).toHaveBeenCalledOnce();
    expect(availableActions().map((a) => a.id)).toEqual(['x.open']);
  });

  it('one combo, several actions: the first usable one in registration order takes it', () => {
    let fileOpen = true;
    offs.push(registerActions([
      { id: 'x.closeFile', label: 'Close file', group: 'File', icon: FolderOpen, tooltip: 'Close the file', shortcuts: ['Ctrl+W'], when: () => fileOpen, run: () => {} },
      { id: 'x.closeTab', label: 'Close tab', group: 'File', icon: FolderOpen, tooltip: 'Close the tab', shortcuts: ['Ctrl+W'], run: () => {} },
    ]));
    expect(actionForCombo('Ctrl+W')?.id).toBe('x.closeFile');
    fileOpen = false;
    expect(actionForCombo('Ctrl+W')?.id).toBe('x.closeTab');
    expect(actionForCombo('')).toBeUndefined();
  });

  it('refuses a duplicate id, and unregistering frees it', () => {
    const a = { id: 'x.dup', label: 'Dup', group: 'Help' as const, icon: Info, tooltip: 'Dup', run: () => {} };
    const off = registerActions([a]);
    expect(() => registerActions([a])).toThrow(/already registered/);
    off();
    offs.push(registerActions([a]));
  });

  it('a failing action is logged, not thrown', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    offs.push(registerActions([{ id: 'x.fail', label: 'Fail', group: 'Help', icon: Info, tooltip: 'Fails', run: async () => { throw new Error('boom'); } }]));
    expect(runAction('x.fail')).toBe(true);
    await vi.waitFor(() => expect(warn).toHaveBeenCalled());
    warn.mockRestore();
  });

  it('every run goes to the action log; a failure toasts with its context action and Details (R11, R12)', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { useActionLog } = await import('../debug/actionLog');
    const { useToast } = await import('../ui/toastStore');
    useActionLog.getState().clear();
    const retry = vi.fn();
    offs.push(registerActions([
      { id: 'x.ok', label: 'Fine', group: 'Help', icon: Info, tooltip: 'Works', run: () => {} },
      { id: 'x.auth', label: 'Push', group: 'Help', icon: Info, tooltip: 'Fails', errorContext: () => ({ retry }), run: () => Promise.reject({ kind: 'AuthFailed', message: 'denied', commandId: 9, stderr: null }) },
      { id: 'x.cancel', label: 'Cancel', group: 'Help', icon: Info, tooltip: 'Cancelled', run: () => Promise.reject({ kind: 'Cancelled', message: 'cancelled', commandId: null, stderr: null }) },
    ]));
    runAction('x.ok');
    expect(useActionLog.getState().entries.at(-1)).toMatchObject({ id: 'x.ok', label: 'Fine', ok: true });
    runAction('x.auth');
    await vi.waitFor(() => expect(useToast.getState().message).toBe('Authentication failed: denied'));
    expect(useToast.getState().actions.map((a) => a.label)).toEqual(['Retry', 'Details']);
    expect(useActionLog.getState().entries.at(-1)).toMatchObject({ id: 'x.auth', ok: false, error: 'denied' });
    useToast.getState().dismiss();
    runAction('x.cancel');
    await vi.waitFor(() => expect(useActionLog.getState().entries.at(-1)?.id).toBe('x.cancel'));
    expect(useToast.getState().message).toBeNull();
    vi.mocked(console.warn).mockRestore();
  });

  it('hamburger: one submenu per non-empty group, in menu order', () => {
    offs.push(registerActions([
      { id: 'h.about', label: 'About GitBolt', group: 'Help', icon: Info, tooltip: 'About', run: () => {} },
      { id: 'f.open', label: 'Open repository…', group: 'File', icon: FolderOpen, tooltip: 'Open', shortcuts: ['Ctrl+O'], run: () => {} },
    ]));
    const rows = hamburgerRows();
    expect(rows.map((r) => (r.kind === 'submenu' ? r.label : '?'))).toEqual(['File', 'Help']);
    const file = rows[0];
    expect(file.kind === 'submenu' && file.rows[0].kind === 'action' && file.rows[0].shortcut).toBe('Ctrl+O');
  });

  it('hamburger: Ctrl+W shows only on the row it would trigger now, never on both', () => {
    let fileOpen = true;
    offs.push(registerActions([
      { id: 'x.closeFile', label: 'Close file', group: 'File', icon: FolderOpen, tooltip: 'Close the file', shortcuts: ['Ctrl+W'], when: () => fileOpen, run: () => {} },
      { id: 'x.closeTab', label: 'Close tab', group: 'File', icon: FolderOpen, tooltip: 'Close the tab', shortcuts: ['Ctrl+W'], run: () => {} },
    ]));
    const label = (id: string, rows: MenuRow[]) => rows.find((r): r is Extract<MenuRow, { kind: 'action' }> => r.kind === 'action' && r.id === id);
    const fileRows = () => { const f = hamburgerRows().find((r) => r.kind === 'submenu' && r.label === 'File'); return f && f.kind === 'submenu' ? f.rows : []; };
    expect(label('x.closeFile', fileRows())?.shortcut).toBe('Ctrl+W');
    expect(label('x.closeTab', fileRows())?.shortcut).toBeUndefined();
    fileOpen = false;
    expect(label('x.closeFile', fileRows())).toBeUndefined();
    expect(label('x.closeTab', fileRows())?.shortcut).toBe('Ctrl+W');
  });

  it('hamburger: an action with `menu: false` is left out of the menu, but stays usable (palette, shortcuts)', () => {
    const run = vi.fn();
    offs.push(registerActions([
      { id: 'v.pick', label: 'Pick…', group: 'View', icon: Info, tooltip: 'Pick', run: () => {} },
      { id: 'v.one', label: 'Pick: one', group: 'View', icon: Info, tooltip: 'One', menu: false, run },
    ]));
    const view = hamburgerRows().find((r) => r.kind === 'submenu' && r.label === 'View');
    expect(view?.kind === 'submenu' && view.rows.map((r) => (r.kind === 'action' ? r.id : '-'))).toEqual(['v.pick']);
    expect(availableActions().map((a) => a.id)).toContain('v.one');
    expect(runAction('v.one')).toBe(true);
    expect(run).toHaveBeenCalledOnce();
  });

  it('hamburger: Quit is the last entry of File, after a separator, even when registered before others (K95)', () => {
    offs.push(registerActions([
      { id: 'file.quit', label: 'Quit', group: 'File', icon: Info, tooltip: 'Quit', run: () => {} },
      { id: 'f.settings', label: 'Settings', group: 'File', icon: FolderOpen, tooltip: 'Settings', run: () => {} },
      { id: 'f.open', label: 'Open', group: 'File', icon: FolderOpen, tooltip: 'Open', run: () => {} },
    ]));
    const file = hamburgerRows()[0];
    const rows = file.kind === 'submenu' ? file.rows : [];
    expect(rows.map((r) => (r.kind === 'separator' ? '-' : r.id))).toEqual(['f.settings', 'f.open', '-', 'file.quit']);
  });
});
