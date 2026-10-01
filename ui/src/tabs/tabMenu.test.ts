import { describe, expect, it, vi } from 'vitest';

vi.mock('../api/client', () => ({
  api: { openIn: vi.fn(async () => null), saveProfile: vi.fn(async () => null), saveSettings: vi.fn(async () => null), appInfo: vi.fn(async () => ({ appVersion: 'x', gitVersion: 'y' })) },
  errorMessage: (e: unknown) => String(e),
}));
vi.mock('../api/transport', () => ({ copyText: vi.fn(async () => {}), inTauri: () => false }));

const { buildMenu } = await import('../menu/registry');
await import('./tabMenu');
import type { MenuRow } from '../menu/types';

const labels = (rows: MenuRow[]) => rows.map((r) => (r.kind === 'separator' ? '---' : r.label));
const find = (rows: MenuRow[], label: string) => rows.find((r) => r.kind === 'action' && r.label === label) as Extract<MenuRow, { kind: 'action' }>;

describe('tab menu', () => {
  it('has the spec §6.2 rows, each with an icon and a tooltip', () => {
    const rows = buildMenu('tab', { tab: { id: 'a', kind: 'repo', path: '/r', alias: null }, index: 0 }, { tabCount: 2, closedCount: 0 });
    expect(labels(rows)).toEqual(['Rename…', '---', 'Close', 'Close others', 'Close to the right', '---', 'Reopen closed tab', '---', 'Copy repo path', 'Open in file manager']);
    for (const r of rows) if (r.kind !== 'separator') { expect(r.icon).toBeDefined(); expect(r.tooltip).toBeTruthy(); }
    expect(find(rows, 'Reopen closed tab').disabledReason).toBe('No recently closed tabs');
    expect(find(rows, 'Close').shortcut).toBe('Ctrl+W');
  });

  it('disables what does not apply and drops repo rows for Open tabs', () => {
    const rows = buildMenu('tab', { tab: { id: 'a', kind: 'open', path: null, alias: null }, index: 0 }, { tabCount: 1, closedCount: 3 });
    expect(find(rows, 'Close others').disabledReason).toBeTruthy();
    expect(find(rows, 'Close to the right').disabledReason).toBeTruthy();
    expect(labels(rows)).not.toContain('Copy repo path');
    expect(find(rows, 'Reopen closed tab').shortcut).toBe('Ctrl+Shift+T');
    expect(find(rows, 'Reopen closed tab').disabledReason).toBeUndefined();
  });
});
