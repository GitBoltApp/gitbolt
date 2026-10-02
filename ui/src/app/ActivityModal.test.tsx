import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const copyText = vi.hoisted(() => vi.fn(async (_t: string) => {}));
const api = vi.hoisted(() => ({
  commandLog: vi.fn(async () => [{ id: 5, args: ['fetch', '--all'], cwd: '/r', startedMs: 1, durationMs: 9, exitCode: 128, stderr: 'fatal: nope' }]),
  logsDir: vi.fn(async (): Promise<string | null> => null),
  diagnostics: vi.fn(async () => 'GitBolt 0.1.0'),
  openLogsFolder: vi.fn(async () => null),
}));
vi.mock('../api/client', () => ({ api, errorMessage: String, onEvent: () => () => {} }));
vi.mock('../api/transport', () => ({ copyText, inTauri: () => false }));

const { ActivityModal } = await import('./ActivityModal');
const { openActivityLog, openDebug, useActivityUi } = await import('./activityLog');
const { useActionLog } = await import('../debug/actionLog');
const { useOps } = await import('./ops');

const finish = (op: number, label: string, interactive: boolean, outcome: 'ok' | 'failed', message: string | null, command: string | null = null) => {
  act(() => useOps.getState().apply({ type: 'opStarted', op, kind: 'fetch', repo: 1, label, interactive }));
  act(() => useOps.getState().apply({ type: 'opFinished', op, kind: 'fetch', repo: 1, outcome, message, command }));
};

describe('ActivityModal (K101)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useOps.setState({ ops: {}, prompts: [], errors: [], unread: 0, activity: [] });
    useActivityUi.setState({ open: false, view: 'activity', focusCommandId: null, perfOverlay: false });
    Element.prototype.scrollIntoView = vi.fn();
  });

  it('lists entries newest first, copies all as text, filters, and Esc closes', () => {
    finish(1, 'shop', false, 'ok', null);
    finish(2, 'shop', true, 'failed', 'git@h: Permission denied (publickey).', 'git fetch --all --prune');
    render(<ActivityModal />);
    expect(screen.queryByRole('dialog')).toBeNull();
    act(() => openActivityLog());
    const dialog = screen.getByRole('dialog', { name: 'Activity' });
    const items = dialog.querySelectorAll('li.activity-entry');
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveTextContent('Permission denied');
    expect(items[0]).toHaveTextContent('user');
    expect(items[0]).toHaveTextContent('$ git fetch --all --prune');
    expect(items[1]).toHaveTextContent('background');
    fireEvent.click(screen.getByRole('button', { name: 'Copy all' }));
    const text = copyText.mock.calls[0][0];
    expect(text).toContain('git fetch --all --prune');
    expect(text.indexOf('Permission denied')).toBeGreaterThan(-1);
    expect(text.indexOf('Permission denied')).toBeLessThan(text.indexOf('background'));
    fireEvent.click(screen.getAllByRole('button', { name: 'Copy entry' })[1]);
    expect(copyText.mock.calls[1][0]).toContain('background');
    fireEvent.click(screen.getByLabelText('Errors only'));
    expect(dialog.querySelectorAll('li.activity-entry')).toHaveLength(1);
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('R9: one modal, named Activity, with Activity | Commands | Actions tabs', async () => {
    render(<ActivityModal />);
    act(() => openDebug('commands', 5));
    const dialog = screen.getByRole('dialog', { name: 'Activity' });
    expect(screen.getByRole('tab', { name: 'Commands' })).toHaveAttribute('aria-selected', 'true');
    await act(async () => { await Promise.resolve(); });
    expect(dialog.querySelector('li.debug-entry[aria-current="true"]')).toHaveTextContent('$ git fetch --all');
    useActionLog.getState().record({ at: Date.now(), id: 'repo.fetch', label: 'Fetch all', ok: true, ms: 3, error: null, source: 'action' });
    fireEvent.click(screen.getByRole('tab', { name: 'Actions' }));
    expect(useActivityUi.getState().view).toBe('actions');
    expect(screen.getByRole('tabpanel')).toHaveTextContent('Fetch all');
    fireEvent.click(screen.getByRole('tab', { name: 'Activity' }));
    expect(screen.getByLabelText('Errors only')).toBeInTheDocument();
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(useActivityUi.getState().focusCommandId).toBeNull();
  });

  it('Help → Activity log always opens on the Activity tab', () => {
    render(<ActivityModal />);
    act(() => openDebug('actions'));
    act(() => useActivityUi.getState().setOpen(false));
    act(() => openActivityLog());
    expect(screen.getByRole('tab', { name: 'Activity' })).toHaveAttribute('aria-selected', 'true');
  });

  it('header: Copy diagnostics, Open logs folder (off without a log folder), Perf overlay toggle', async () => {
    render(<ActivityModal />);
    act(() => openActivityLog());
    await act(async () => { await Promise.resolve(); });
    expect(screen.getByRole('button', { name: 'Open logs folder' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Copy diagnostics' }));
    await vi.waitFor(() => expect(copyText).toHaveBeenCalledWith('GitBolt 0.1.0'));
    const perf = screen.getByRole('button', { name: 'Perf overlay' });
    expect(perf).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(perf);
    expect(useActivityUi.getState().perfOverlay).toBe(true);
    expect(perf).toHaveAttribute('aria-pressed', 'true');
    act(() => useActivityUi.getState().setOpen(false));
    api.logsDir.mockResolvedValueOnce('/home/u/.cache/gitbolt/logs');
    act(() => openActivityLog());
    await act(async () => { await Promise.resolve(); });
    const logs = screen.getByRole('button', { name: 'Open logs folder' });
    expect(logs).toBeEnabled();
    fireEvent.click(logs);
    expect(api.openLogsFolder).toHaveBeenCalledOnce();
  });

  it('shows a server output section first, linkified, expanded for the focused op', async () => {
    useOps.setState({ activity: [{ at: 1, op: 9, kind: 'push', label: 'push dev', background: false, durationMs: 5, outcome: 'ok', message: null, command: null, output: [], remote: [{ text: 'To create a merge request for dev, visit:', kind: 'boilerplate' }, { text: '  https://gitlab.example/mr/new', kind: 'boilerplate' }, { text: 'integration: rebase failed', kind: 'warning' }] }] });
    useActivityUi.setState({ open: true, view: 'activity', focusOp: 9 });
    render(<ActivityModal />);
    const section = await screen.findByText('Server output (1 line)');
    expect(section.closest('details')).toHaveAttribute('open');
    expect(screen.getByRole('link', { name: 'https://gitlab.example/mr/new' })).toBeInTheDocument();
    expect(screen.getByText('integration: rebase failed')).toHaveClass('remote-warning');
  });
});
