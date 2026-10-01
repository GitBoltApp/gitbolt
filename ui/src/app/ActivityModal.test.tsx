import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const copyText = vi.hoisted(() => vi.fn(async (_t: string) => {}));
vi.mock('../api/client', () => ({ api: {}, errorMessage: String, onEvent: () => () => {} }));
vi.mock('../api/transport', () => ({ copyText, inTauri: () => false }));

const { ActivityModal } = await import('./ActivityModal');
const { openActivityLog } = await import('./activityLog');
const { useOps } = await import('./ops');

const finish = (op: number, label: string, interactive: boolean, outcome: 'ok' | 'failed', message: string | null, command: string | null = null) => {
  act(() => useOps.getState().apply({ type: 'opStarted', op, kind: 'fetch', repo: 1, label, interactive }));
  act(() => useOps.getState().apply({ type: 'opFinished', op, kind: 'fetch', repo: 1, outcome, message, command }));
};

describe('ActivityModal (K101)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useOps.setState({ ops: {}, prompts: [], errors: [], unread: 0, activity: [] });
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
});
