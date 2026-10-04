import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS, EMPTY_PROFILE } from '../app/state';

const api = vi.hoisted(() => ({
  forgeRepoProjects: vi.fn(async (): Promise<unknown> => ({ remotes: [], target: null })),
  forgeForks: vi.fn(async (): Promise<unknown[]> => []),
}));
const added = vi.hoisted(() => ({ addRemoteAndFetch: vi.fn(async () => true), addForkRemote: vi.fn(async () => 'alice') }));
vi.mock('../api/client', () => ({ api, errorMessage: (e: unknown) => (e && typeof e === 'object' && 'message' in e ? String((e as { message: unknown }).message) : String(e)) }));
vi.mock('../api/transport', () => ({ copyText: vi.fn(async () => {}), inTauri: () => false }));
vi.mock('./addRemote', () => added);

const { AddRemoteDialog, openAddRemote, closeAddRemote } = await import('./AddRemoteDialog');
const { useAppState } = await import('../app/state');
const { useRuntime } = await import('../app/runtime');

const project = (path: string, updatedAt: number, forkOf: string | null = 'group/project') => ({
  kind: 'gitlab', id: updatedAt, host: 'gitlab.example.com', path, name: 'project', owner: path.split('/')[0], webUrl: 'w', defaultBranch: 'main',
  cloneHttps: `https://gitlab.example.com/${path}.git`, cloneSsh: `git@gitlab.example.com:${path}.git`, forkOf, updatedAt, archived: false,
});

beforeEach(() => {
  vi.clearAllMocks();
  useAppState.setState({ settings: DEFAULT_SETTINGS, profile: { ...EMPTY_PROFILE } });
  useRuntime.setState({ tabs: { t1: { status: 'ready', repo: { id: 7, name: 'shop', path: '/r/shop' }, info: { remotes: [
    { name: 'origin', url: 'https://gitlab.example.com/group/project.git', host: 'gitlab.example.com', path: 'group/project', hostKind: 'gitlab' },
    { name: 'bob', url: 'https://gitlab.example.com/bob/project.git', host: 'gitlab.example.com', path: 'bob/project', hostKind: 'gitlab' },
  ] } } } as never });
  api.forgeRepoProjects.mockResolvedValue({ remotes: [{ remote: 'origin', host: 'gitlab.example.com', path: 'group/project', account: 'gitlab', project: project('group/project', 9, null), error: null }], target: 'origin' });
  api.forgeForks.mockResolvedValue([project('alice/project', 1_791_021_600), project('bob/project', 1_700_000_000)]);
  act(() => closeAddRemote());
});

const show = () => {
  render(<AddRemoteDialog />);
  act(() => openAddRemote('t1'));
  return screen.getByRole('dialog', { name: 'Add remote' });
};

describe('Add remote', () => {
  it("detects the forge from the URL and names the remote after the URL's owner", () => {
    show();
    fireEvent.change(screen.getByLabelText('Remote URL'), { target: { value: 'git@gitlab.example.com:carol/project.git' } });
    expect(screen.getByTestId('add-remote-detected').textContent).toContain('GitLab · gitlab.example.com/carol/project');
    expect((screen.getByLabelText('Remote name') as HTMLInputElement).value).toBe('carol');
    fireEvent.change(screen.getByLabelText('Remote name'), { target: { value: 'origin' } });
    expect(screen.getByRole('alert').textContent).toBe('A remote named origin already exists');
    expect((screen.getByRole('button', { name: 'Add remote' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('adds by URL and closes', async () => {
    show();
    fireEvent.change(screen.getByLabelText('Remote URL'), { target: { value: ' /srv/git/carol.git ' } });
    fireEvent.change(screen.getByLabelText('Remote name'), { target: { value: 'carol' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add remote' }));
    await waitFor(() => expect(added.addRemoteAndFetch).toHaveBeenCalledWith('t1', 'carol', '/srv/git/carol.git'));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it("lists the target project's forks, newest first, and adds one in a click", async () => {
    show();
    expect(await screen.findByRole('heading', { name: 'Forks of group/project' })).toBeTruthy();
    const rows = await screen.findAllByRole('listitem');
    expect(rows.map((r) => r.querySelector('.fork-path')?.textContent)).toEqual(['alice/project', 'bob/project']);
    expect(rows[1].textContent).toContain('Added as bob');
    expect(api.forgeForks).toHaveBeenCalledWith(7, 'origin');
    fireEvent.click(screen.getByRole('button', { name: "Add alice's fork" }));
    await waitFor(() => expect(added.addForkRemote).toHaveBeenCalledWith('t1', expect.objectContaining({ path: 'alice/project' })));
  });

  it('shows no forks section without an account', async () => {
    api.forgeRepoProjects.mockResolvedValueOnce({ remotes: [{ remote: 'origin', host: 'gitlab.example.com', path: 'group/project', account: null, project: null, error: null }], target: null });
    show();
    await waitFor(() => expect(api.forgeRepoProjects).toHaveBeenCalled());
    expect(screen.queryByRole('region', { name: 'Forks' })).toBeNull();
    expect(api.forgeForks).not.toHaveBeenCalled();
  });

  it('says why the forks could not be listed', async () => {
    api.forgeForks.mockRejectedValueOnce({ kind: 'RateLimited', message: 'gitlab.example.com rate limit reached: try again in 2 min' });
    show();
    expect((await screen.findByRole('alert')).textContent).toBe('gitlab.example.com rate limit reached: try again in 2 min');
    expect(screen.getByRole('heading', { name: 'Forks of group/project' })).toBeTruthy();
  });
});
