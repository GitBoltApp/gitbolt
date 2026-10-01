import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppEvent } from '../api/gen/AppEvent';

const handlers = vi.hoisted(() => new Set<(ev: AppEvent) => void>());
/** The backend's forwarded-path queue: `takeOpenRequests` returns each path once. */
const queue = vi.hoisted(() => [] as string[]);
vi.mock('../api/client', () => ({
  api: {
    saveProfile: vi.fn(async () => null),
    saveSettings: vi.fn(async () => null),
    takeOpenRequests: vi.fn(async () => queue.splice(0)),
  },
  errorMessage: (e: unknown) => String(e),
  onEvent: (h: (ev: AppEvent) => void) => { handlers.add(h); return () => { handlers.delete(h); }; },
}));
const openPathInTab = vi.hoisted(() => vi.fn(async (_path: string) => {}));
vi.mock('./runtime', () => ({ openPathInTab }));

const { installOpenRequests, openPendingRequests } = await import('./instance');
const { useAppState } = await import('./state');

/** What the backend does for a later launch: queue, then announce. */
const forward = (path: string) => {
  queue.push(path);
  for (const h of handlers) h({ type: 'openRequested', path });
};
const flush = () => new Promise((r) => setTimeout(r, 0));
const opened = () => openPathInTab.mock.calls.map((c) => c[0]);

describe('openRequested (single-instance guard)', () => {
  beforeEach(() => {
    handlers.clear();
    queue.length = 0;
    openPathInTab.mockClear();
    useAppState.setState({ booted: true });
  });

  it('opens the forwarded path with openPathInTab', async () => {
    installOpenRequests();
    forward('/home/u/repo');
    await vi.waitFor(() => expect(opened()).toEqual(['/home/u/repo']));
  });

  it('ignores other events', async () => {
    installOpenRequests();
    queue.push('/not-announced');
    for (const h of handlers) h({ type: 'refsUpdated', repo: 1 });
    await flush();
    expect(openPathInTab).not.toHaveBeenCalled();
  });

  it('boot opens a path forwarded before the page listened, once, even if its event arrives too', async () => {
    queue.push('/early'); // forwarded during app startup: no page was listening
    useAppState.setState({ booted: false });
    installOpenRequests();
    forward('/during-boot');
    await flush();
    expect(openPathInTab).not.toHaveBeenCalled();
    useAppState.getState().setBooted();
    await openPendingRequests();
    await flush();
    expect(opened().sort()).toEqual(['/during-boot', '/early']);
    await openPendingRequests();
    await flush();
    expect(openPathInTab).toHaveBeenCalledTimes(2);
  });

  it('opens requests in the order they came', async () => {
    useAppState.setState({ booted: false });
    installOpenRequests();
    forward('/a');
    forward('/b');
    useAppState.getState().setBooted();
    await vi.waitFor(() => expect(openPathInTab).toHaveBeenCalledTimes(2));
    expect(opened()).toEqual(['/a', '/b']);
  });

  it('a failed open is logged, not thrown, and the rest still open', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    openPathInTab.mockRejectedValueOnce(new Error('not a repository'));
    queue.push('/nope', '/ok');
    await openPendingRequests();
    expect(warn).toHaveBeenCalled();
    expect(opened()).toEqual(['/nope', '/ok']);
    warn.mockRestore();
  });

  it('unsubscribes', async () => {
    const off = installOpenRequests();
    off();
    forward('/x');
    await flush();
    expect(openPathInTab).not.toHaveBeenCalled();
  });
});
