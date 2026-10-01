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
});
