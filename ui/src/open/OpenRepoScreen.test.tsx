import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const rt = vi.hoisted(() => ({ openPathInTab: vi.fn(async () => undefined) }));
vi.mock('../app/runtime', async (orig) => ({ ...(await orig<typeof import('../app/runtime')>()), openPathInTab: rt.openPathInTab }));
const api = vi.hoisted(() => ({
  clone: vi.fn(),
  pickFolder: vi.fn(),
  scanFolders: vi.fn(),
  suggestReposFolder: vi.fn(),
  cancelOp: vi.fn(),
}));
vi.mock('../api/client', () => ({ api, errorMessage: (e: unknown) => String((e as { message?: string }).message ?? e) }));

import { useRuntime } from '../app/runtime';
import { EMPTY_PROFILE, useAppState } from '../app/state';
import { OpenRepoScreen } from './OpenRepoScreen';

const tab = { id: 't1', kind: 'open' as const, path: null, alias: null };
const recent = (name: string, pinned: boolean, openedAt: number) => ({ path: `/r/${name}`, name, pinned, openedAt });

describe('OpenRepoScreen', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.suggestReposFolder.mockResolvedValue('/home/u/repos');
    api.scanFolders.mockResolvedValue([]);
    useAppState.setState({ loaded: true, profile: { ...EMPTY_PROFILE, id: 'p', tabs: [tab], activeTab: 't1' } });
  });
  afterEach(cleanup);

  it('first run offers the suggested repos folder, and using it hides the banner', async () => {
    render(<OpenRepoScreen tab={tab} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Use /home/u/repos' }));
    expect(useAppState.getState().profile.reposFolder).toBe('/home/u/repos');
    expect(screen.queryByRole('region', { name: 'Default repos folder' })).toBeNull();
    await waitFor(() => expect(api.scanFolders).toHaveBeenCalledWith(['/home/u/repos'], false));
  });

  it('a recent repository that fails to open offers Remove from recent inline, which drops it', async () => {
    useAppState.setState({ profile: { ...EMPTY_PROFILE, id: 'p', reposFolder: '/x', recent: [recent('gone', false, 1)] } });
    rt.openPathInTab.mockImplementationOnce(async () => { useRuntime.setState({ tabs: { t1: { error: 'not a repository' } } as never }); });
    render(<OpenRepoScreen tab={tab} />);
    fireEvent.click(screen.getByTitle('/r/gone'));
    fireEvent.click(await screen.findByRole('button', { name: 'Remove from recent' }));
    expect(useAppState.getState().profile.recent).toEqual([]);
  });

  it('recent: pinned first, then newest; the filter narrows it', () => {
    useAppState.setState({ profile: { ...EMPTY_PROFILE, id: 'p', reposFolder: '/x', recent: [recent('old', false, 1), recent('new', false, 9), recent('pin', true, 0)] } });
    render(<OpenRepoScreen tab={tab} />);
    const names = () => screen.getAllByRole('button', { name: /^(old|new|pin)\b/ }).map((b) => b.querySelector('.open-name')!.textContent);
    expect(names()).toEqual(['pin', 'new', 'old']);
    fireEvent.change(screen.getByLabelText('Filter recent repositories'), { target: { value: 'ol' } });
    expect(names()).toEqual(['old']);
  });

  it('the clone destination follows the URL until it is edited', () => {
    useAppState.setState({ profile: { ...EMPTY_PROFILE, id: 'p', reposFolder: '/home/u/repos/' } });
    render(<OpenRepoScreen tab={tab} />);
    const dest = screen.getByLabelText('Destination') as HTMLInputElement;
    fireEvent.change(screen.getByLabelText('Repository URL'), { target: { value: 'git@h:g/proj.git' } });
    expect(dest.value).toBe('/home/u/repos/proj');
    fireEvent.change(dest, { target: { value: '/elsewhere/p' } });
    fireEvent.change(screen.getByLabelText('Repository URL'), { target: { value: 'git@h:g/other.git' } });
    expect(dest.value).toBe('/elsewhere/p');
  });

  it('a failed clone shows its error inline and re-enables the form', async () => {
    api.clone.mockRejectedValue({ kind: 'Io', message: 'destination exists' });
    useAppState.setState({ profile: { ...EMPTY_PROFILE, id: 'p', reposFolder: '/home/u/repos' } });
    render(<OpenRepoScreen tab={tab} />);
    fireEvent.change(screen.getByLabelText('Repository URL'), { target: { value: 'file:///o.git' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Clone' })); });
    expect((await screen.findByRole('alert')).textContent).toBe('destination exists');
    expect(api.clone).toHaveBeenCalledWith('file:///o.git', '/home/u/repos/o');
    expect((screen.getByLabelText('Repository URL') as HTMLInputElement).disabled).toBe(false);
  });

  const startClone = async (kind?: string) => {
    useAppState.setState({ profile: { ...EMPTY_PROFILE, id: 'p', reposFolder: '/home/u/repos', tabs: [tab], activeTab: 't1' } });
    if (kind) api.clone.mockRejectedValue({ kind, message: 'raw' });
    render(<OpenRepoScreen tab={tab} />);
    fireEvent.change(screen.getByLabelText('Repository URL'), { target: { value: 'file:///o.git' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Clone' })); });
  };

  it.each([['Cancelled', 'Clone cancelled'], ['AuthFailed', 'Authentication failed or was cancelled']])('a %s clone reads "%s"', async (kind, text) => {
    await startClone(kind);
    expect((await screen.findByRole('alert')).textContent).toBe(text);
  });

  it('an invalid URL or relative destination disables Clone and says why', () => {
    useAppState.setState({ profile: { ...EMPTY_PROFILE, id: 'p', reposFolder: '/r' } });
    render(<OpenRepoScreen tab={tab} />);
    const clone = screen.getByRole('button', { name: 'Clone' }) as HTMLButtonElement;
    fireEvent.change(screen.getByLabelText('Repository URL'), { target: { value: 'nonsense' } });
    expect(screen.getByRole('alert').textContent).toMatch(/Not a repository URL/);
    expect(clone.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Repository URL'), { target: { value: 'file:///o.git' } });
    expect(clone.disabled).toBe(false);
    fireEvent.change(screen.getByLabelText('Destination'), { target: { value: 'rel/o' } });
    expect(screen.getByRole('alert').textContent).toMatch(/absolute/);
    expect(clone.disabled).toBe(true);
  });

  it('the finished clone fills the tab that started it', async () => {
    api.clone.mockResolvedValue({ id: 1, path: '/home/u/repos/o', name: 'o' });
    await startClone();
    expect(rt.openPathInTab).toHaveBeenCalledWith('/home/u/repos/o', 't1');
  });

  it('a clone whose tab was closed meanwhile opens in a new tab', async () => {
    let finish!: (v: unknown) => void;
    api.clone.mockReturnValue(new Promise((r) => { finish = r; }));
    await startClone();
    act(() => useAppState.setState({ profile: { ...useAppState.getState().profile, tabs: [], activeTab: null } }));
    await act(async () => { finish({ id: 1, path: '/home/u/repos/o', name: 'o' }); });
    expect(rt.openPathInTab).toHaveBeenCalledWith('/home/u/repos/o', undefined);
  });

  it('a failed scan and a failed folder pick show inline errors', async () => {
    api.scanFolders.mockRejectedValue({ message: 'permission denied' });
    api.pickFolder.mockRejectedValue({ message: 'no portal' });
    useAppState.setState({ profile: { ...EMPTY_PROFILE, id: 'p', reposFolder: '/x' } });
    render(<OpenRepoScreen tab={tab} />);
    expect((await screen.findByRole('alert')).textContent).toBe("Couldn't scan: permission denied");
    expect(screen.queryByText(/No repositories found/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Open folder/ }));
    await waitFor(() => expect(screen.getAllByRole('alert').map((a) => a.textContent)).toContain('no portal'));
  });

  it('Your repos merges the profile folders; + adds a picked folder, x removes one', async () => {
    api.scanFolders.mockResolvedValue([{ path: '/a/one', name: 'one', branch: 'main', modified: 1 }]);
    useAppState.setState({ profile: { ...EMPTY_PROFILE, id: 'p', reposFolder: '/a', reposFolders: ['/a'] } });
    render(<OpenRepoScreen tab={tab} />);
    await waitFor(() => expect(api.scanFolders).toHaveBeenLastCalledWith(['/a'], false));
    api.pickFolder.mockResolvedValueOnce('/b');
    fireEvent.click(screen.getByRole('button', { name: 'Add folder' }));
    await waitFor(() => expect(useAppState.getState().profile.reposFolders).toEqual(['/a', '/b']));
    await waitFor(() => expect(api.scanFolders).toHaveBeenLastCalledWith(['/a', '/b'], false));
    api.pickFolder.mockResolvedValueOnce('/b/'); // the same folder again: not added twice
    fireEvent.click(screen.getByRole('button', { name: 'Add folder' }));
    await waitFor(() => expect(api.pickFolder).toHaveBeenCalledTimes(2));
    expect(useAppState.getState().profile.reposFolders).toEqual(['/a', '/b']);
    fireEvent.click(screen.getByRole('button', { name: 'Remove folder /a' }));
    expect(useAppState.getState().profile.reposFolders).toEqual(['/b']);
    await waitFor(() => expect(api.scanFolders).toHaveBeenLastCalledWith(['/b'], false));
    expect(screen.getByRole('list', { name: 'Scanned folders' }).textContent).not.toContain('/a');
  });

  it('a profile with every folder removed says how to add one', () => {
    useAppState.setState({ profile: { ...EMPTY_PROFILE, id: 'p', reposFolder: '/a', reposFolders: [] } });
    render(<OpenRepoScreen tab={tab} />);
    expect(screen.getByText(/Add a folder with \+/)).toBeTruthy();
    expect(api.scanFolders).not.toHaveBeenCalled();
  });
});
