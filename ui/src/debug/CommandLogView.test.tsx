import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CommandLogEntry } from '../api/gen/CommandLogEntry';

const commandLog = vi.hoisted(() => vi.fn(async (): Promise<CommandLogEntry[]> => []));
const copyText = vi.hoisted(() => vi.fn(async (_t: string) => {}));
vi.mock('../api/client', () => ({ api: { commandLog }, errorMessage: String, onEvent: () => () => {} }));
vi.mock('../api/transport', () => ({ copyText, inTauri: () => false }));

const { CommandLogView, commandLine, filterCommands, isReadCommand, subcommandOf } = await import('./CommandLogView');

const e = (id: number, args: string[], exitCode: number | null, stderr = ''): CommandLogEntry => ({ id, args, cwd: '/r', startedMs: 1_767_225_600_000 + id, durationMs: id, exitCode, stderr });
const entries = [e(1, ['status'], 0), e(2, ['fetch', '--all'], 128, 'fatal: Authentication failed'), e(3, ['log', '--format=%H %s'], 0)];

describe('the Commands tab (R10)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    commandLog.mockReset();
    commandLog.mockResolvedValue(entries);
    copyText.mockClear();
    Element.prototype.scrollIntoView = vi.fn();
  });
  afterEach(() => vi.useRealTimers());

  it('filters by text across args, cwd and stderr, and by failure', () => {
    expect(filterCommands(entries, 'fetch', false).map((x) => x.id)).toEqual([2]);
    expect(filterCommands(entries, 'AUTHENTICATION', false).map((x) => x.id)).toEqual([2]);
    expect(filterCommands(entries, '', true).map((x) => x.id)).toEqual([2]);
    expect(filterCommands([e(4, ['x'], null)], '', true)).toHaveLength(1); // no exit code: killed or never started
    expect(filterCommands(entries, '', false)).toHaveLength(3);
  });

  it('Hide reads keeps the actions, a failed read, and the command an error points at', () => {
    const log = [e(1, ['status'], 0), e(2, ['-c', 'core.quotepath=off', 'diff', '--stat'], 0), e(3, ['commit', '-m', 'x'], 0), e(4, ['log'], 128, 'bad'), e(5, ['rev-parse', 'HEAD'], 0)];
    expect(filterCommands(log, '', false, true).map((x) => x.id)).toEqual([3, 4]);
    expect(filterCommands(log, '', false, true, 5).map((x) => x.id)).toEqual([3, 4, 5]);
    expect(filterCommands(log, '', false, false)).toHaveLength(5);
  });

  it('knows a read from an action, past git\'s global options', () => {
    expect(subcommandOf(['-C', '/r', '-c', 'a=b', '--no-optional-locks', 'status'])).toBe('status');
    const read = (args: string[]) => isReadCommand(e(9, args, 0));
    expect(read(['status', '--porcelain=v2'])).toBe(true);
    expect(read(['config', '--get', 'user.name'])).toBe(true);
    expect(read(['config', 'user.name', 'X'])).toBe(false);
    expect(read(['branch', '--list'])).toBe(true);
    expect(read(['branch', '-D', 'old'])).toBe(false);
    expect(read(['stash', 'list'])).toBe(true);
    expect(read(['stash', 'push'])).toBe(false);
    expect(read(['--version'])).toBe(true);
    expect(read(['fetch', '--all'])).toBe(false);
    expect(read(['push', 'origin', 'main'])).toBe(false);
  });

  it('writes a command line that pastes into a shell', () => {
    expect(commandLine(entries[2])).toBe("$ git log '--format=%H %s'");
    expect(commandLine(e(5, ['commit', '-m', "it's"], 0))).toBe("$ git commit -m 'it'\\''s'");
  });

  it('shows newest first, highlights and scrolls to the focused command, filters, and polls each second while shown', async () => {
    const { unmount } = render(<CommandLogView focusId={2} />);
    await act(async () => { await Promise.resolve(); });
    const items = () => [...document.querySelectorAll('li.debug-entry')];
    // Hide reads is on by default: only the fetch (an action) shows; off, every command.
    expect(screen.getByLabelText('Hide reads')).toBeChecked();
    expect(items()).toHaveLength(1);
    fireEvent.click(screen.getByLabelText('Hide reads'));
    expect(items()).toHaveLength(3);
    expect(items()[0]).toHaveTextContent("$ git log '--format=%H %s'");
    expect(items()[1]).toHaveAttribute('aria-current', 'true');
    expect(items()[1]).toHaveTextContent('fatal: Authentication failed');
    expect(items()[1]).toHaveTextContent('exit 128');
    expect(Element.prototype.scrollIntoView).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByLabelText('Failed only'));
    expect(items()).toHaveLength(1);
    fireEvent.click(screen.getByLabelText('Failed only'));
    fireEvent.change(screen.getByRole('searchbox', { name: 'Filter commands' }), { target: { value: 'status' } });
    expect(items()).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Copy all' }));
    await act(async () => { await Promise.resolve(); });
    expect(copyText.mock.calls[0][0]).toContain('$ git status');
    expect(copyText.mock.calls[0][0]).not.toContain('fetch');

    expect(commandLog).toHaveBeenCalledTimes(1);
    commandLog.mockResolvedValue([...entries, e(4, ['diff'], 0)]);
    await act(async () => { vi.advanceTimersByTime(1000); await Promise.resolve(); });
    expect(commandLog).toHaveBeenCalledTimes(2);
    fireEvent.change(screen.getByRole('searchbox', { name: 'Filter commands' }), { target: { value: '' } });
    expect(items()).toHaveLength(4);
    unmount();
    await act(async () => { vi.advanceTimersByTime(3000); });
    expect(commandLog).toHaveBeenCalledTimes(2);
  });

  it('says so when the focused command has left the log', async () => {
    render(<CommandLogView focusId={99} />);
    await act(async () => { await Promise.resolve(); });
    expect(screen.getByText(/Command #99 is no longer in the log/)).toBeInTheDocument();
  });
});
