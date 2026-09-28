import { Copy, Eye, GitMerge } from 'lucide-react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MenuRow } from './types';
import { buildMenu, registerMenu, tmpl } from './registry';

const row = (id: string, label: string, icon = Copy): MenuRow => ({ kind: 'action', id, label, icon, tooltip: label, run: () => {} });
const labels = (rows: MenuRow[]) => rows.map((r) => (r.kind === 'separator' ? '---' : r.label));

describe('menu registry', () => {
  const offs: Array<() => void> = [];
  afterEach(() => { offs.splice(0).forEach((f) => f()); });

  it('orders groups per kind, separates non-empty groups, orders rows in a group', () => {
    offs.push(registerMenu<{ b: string }, { head: string }>({ id: 'view.compare', kind: 'commit', group: 'view', order: 10, rows: () => [row('cmp', 'Compare with HEAD', Eye)] }));
    offs.push(registerMenu<{ b: string }, { head: string }>({ id: 'copy.sha', kind: 'commit', group: 'copy', order: 20, rows: () => [row('sha', 'Copy SHA')] }));
    offs.push(registerMenu<{ b: string }, { head: string }>({ id: 'copy.name', kind: 'commit', group: 'copy', order: 10, rows: () => [row('name', 'Copy branch name')] }));
    offs.push(registerMenu<{ b: string }, { head: string }>({ id: 'integrate.merge', kind: 'commit', group: 'integrate', order: 0, rows: (t, e) => [row('merge', tmpl('Merge {X} into {Y}', { X: e.head, Y: t.b }), GitMerge)] }));
    const rows = buildMenu('commit', { b: 'feature/x' }, { head: 'main' });
    expect(labels(rows)).toEqual(['Merge main into feature/x', '---', 'Copy branch name', 'Copy SHA', '---', 'Compare with HEAD']);
  });

  it('gates contributions with `when` and drops empty groups', () => {
    offs.push(registerMenu<{ wip: boolean }, object>({ id: 'copy.sha', kind: 'commit', group: 'copy', order: 0, when: (t) => !t.wip, rows: () => [row('sha', 'Copy SHA')] }));
    offs.push(registerMenu<{ wip: boolean }, object>({ id: 'view.x', kind: 'commit', group: 'view', order: 0, rows: () => [] }));
    expect(buildMenu('commit', { wip: true }, {})).toEqual([]);
    expect(labels(buildMenu('commit', { wip: false }, {}))).toEqual(['Copy SHA']);
  });

  it('unregisters and rejects duplicate ids', () => {
    const off = registerMenu({ id: 'dup', kind: 'tab', group: 'close', order: 0, rows: () => [row('a', 'A')] });
    expect(() => registerMenu({ id: 'dup', kind: 'tab', group: 'close', order: 0, rows: () => [] })).toThrow(/dup/);
    off();
    expect(buildMenu('tab', {}, {})).toEqual([]);
  });

  it('on the dev server, a hot-reloaded registration replaces the previous one', () => {
    vi.stubEnv('MODE', 'development');
    try {
      const stale = registerMenu({ id: 'hmr', kind: 'tab', group: 'close', order: 0, rows: () => [row('old', 'Old')] });
      offs.push(registerMenu({ id: 'hmr', kind: 'tab', group: 'close', order: 0, rows: () => [row('new', 'New')] }));
      expect(labels(buildMenu('tab', {}, {}))).toEqual(['New']);
      // The stale module's unregister leaves the new registration alone.
      stale();
      expect(labels(buildMenu('tab', {}, {}))).toEqual(['New']);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('templates HEAD (X) and the clicked branch (Y), falling back to generic words', () => {
    expect(tmpl('Fast-forward {Y} to {X}', { X: 'main', Y: 'dev' })).toBe('Fast-forward dev to main');
    expect(tmpl('Merge {X} into {Y}', { X: null, Y: 'dev' })).toBe('Merge HEAD into dev');
  });
});
