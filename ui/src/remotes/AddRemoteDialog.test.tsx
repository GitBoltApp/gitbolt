import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS, EMPTY_PROFILE } from '../app/state';

const api = vi.hoisted(() => ({
  forgeRepoProjects: vi.fn(async (): Promise<unknown> => ({ remotes: [], target: null })),
  forgeForks: vi.fn(async (..._a: unknown[]): Promise<unknown> => ({ forks: [], next: null })),
}));
const added = vi.hoisted(() => ({ addRemoteAndFetch: vi.fn(async () => true), addForkRemote: vi.fn(async () => 'alice') }));
vi.mock('../api/client', () => ({ api, errorMessage: (e: unknown) => (e && typeof e === 'object' && 'message' in e ? String((e as { message: unknown }).message) : String(e)) }));
vi.mock('../api/transport', () => ({ copyText: vi.fn(async () => {}), inTauri: () => false }));
vi.mock('./addRemote', () => added);

const { AddRemoteDialog, openAddRemote, closeAddRemote } = await import('./AddRemoteDialog');
const { useAppState } = await import('../app/state');
const { useRuntime } = await import('../app/runtime');
const { useForge, EMPTY_FORGE } = await import('../forge/mrStore');

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
  api.forgeForks.mockResolvedValue({ forks: [project('alice/project', 1_791_021_600), project('bob/project', 1_700_000_000)], next: null });
  useForge.setState({ byTab: { t1: { ...EMPTY_FORGE, kind: 'gitlab' } } });
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
    // A generic host is just the host and path.
    fireEvent.change(screen.getByLabelText('Remote URL'), { target: { value: 'https://code.example.com/carol/project.git' } });
    expect(screen.getByTestId('add-remote-detected').textContent?.trim()).toBe('code.example.com/carol/project');
    fireEvent.change(screen.getByLabelText('Remote URL'), { target: { value: 'git@gitlab.example.com:carol/project.git' } });
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
    expect(api.forgeForks).toHaveBeenCalledWith(7, 'origin', 1, 10);
    fireEvent.click(screen.getByRole('button', { name: "Add alice's fork" }));
    await waitFor(() => expect(added.addForkRemote).toHaveBeenCalledWith('t1', expect.objectContaining({ path: 'alice/project' })));
  });

  it('a fork on a ported host shows as added when a remote reaches it without the port', async () => {
    api.forgeForks.mockResolvedValueOnce({ forks: [{ ...project('bob/project', 1), host: 'gitlab.example.com:8443' }], next: null });
    show();
    const rows = await screen.findAllByRole('listitem');
    expect(rows[0].textContent).toContain('Added as bob');
    expect(screen.queryByRole('button', { name: "Add bob's fork" })).toBeNull();
  });

  it('shows no forks section without an account', async () => {
    useForge.setState({ byTab: {} });
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

  describe('reserved space', () => {
    const box = () => screen.getByTestId('fork-box');
    it('the forks box has a fixed height in the stylesheet and holds loading, forks, empty and error alike', async () => {
      const css = readFileSync('src/remotes/remotes.css', 'utf8');
      expect(css).toMatch(/\.fork-box \{ height: min\(240px, 40vh\);/);
      expect(css).toMatch(/\.fork-list \{[^}]*flex: 1; min-height: 0; overflow: auto;/);
      let release!: (v: unknown) => void;
      api.forgeForks.mockImplementationOnce(() => new Promise((r) => { release = r; }));
      const dialog = show();
      await screen.findByText('Loading forks…');
      const el = box();
      expect(el.textContent).toContain('Loading forks…');
      const cls = el.className;
      await act(async () => { release({ forks: [project('alice/project', 5)], next: null }); });
      await screen.findByText('alice/project');
      expect(box()).toBe(el);
      expect(box().className).toBe(cls);
      expect(box().querySelector('.fork-list')).toBeTruthy();
      expect(dialog.querySelectorAll('.fork-box')).toHaveLength(1);
    });
    it('is there from the first frame when the tab already has a forge, and stays when the lookup finds none', async () => {
      useForge.setState({ byTab: { t1: { ...EMPTY_FORGE, kind: 'gitlab' } } });
      api.forgeRepoProjects.mockResolvedValueOnce({ remotes: [], target: null });
      show();
      expect(box()).toBeTruthy();
      expect(screen.getByText('Loading forks…')).toBeTruthy();
      expect(await screen.findByText('No forks to show')).toBeTruthy();
      expect(box().className).toBe('fork-box');
      useForge.setState({ byTab: {} });
    });
    it('an empty result and an error sit in the same box', async () => {
      api.forgeForks.mockResolvedValueOnce({ forks: [], next: null });
      show();
      const empty = await screen.findByText('No forks yet');
      expect(box().contains(empty)).toBe(true);
      expect(box().className).toBe('fork-box');
    });
    it('an error sits in the same box', async () => {
      api.forgeForks.mockRejectedValueOnce({ kind: 'RateLimited', message: 'rate limited' });
      show();
      const err = await screen.findByRole('alert');
      expect(box().contains(err)).toBe(true);
      expect(box().className).toBe('fork-box');
    });
  });

  describe('lazy forks', () => {
    const page = (from: number, n: number, next: number | null) => ({ forks: Array.from({ length: n }, (_, i) => project(`user${from + i}/project`, 1000 - from - i)), next });
    const rows = () => screen.getAllByRole('listitem').filter((r) => r.classList.contains('fork-row'));

    it('loads page 2 on the button, appends it, and hides the button on the last page', async () => {
      api.forgeForks.mockResolvedValueOnce(page(0, 10, 2)).mockResolvedValueOnce(page(10, 5, null));
      show();
      await screen.findAllByRole('listitem');
      expect(rows()).toHaveLength(10);
      fireEvent.click(screen.getByRole('button', { name: 'Load more forks' }));
      await waitFor(() => expect(rows()).toHaveLength(15));
      expect(api.forgeForks).toHaveBeenLastCalledWith(7, 'origin', 2, 10);
      expect(screen.queryByRole('button', { name: 'Load more forks' })).toBeNull();
    });

    it('loads the next page when the sentinel scrolls into view, once at a time', async () => {
      let fire: (() => void) | null = null;
      vi.stubGlobal('IntersectionObserver', class { constructor(cb: (e: { isIntersecting: boolean }[]) => void) { fire = () => cb([{ isIntersecting: true }]); } observe() {} disconnect() {} });
      let resolve: (v: unknown) => void = () => {};
      api.forgeForks.mockResolvedValueOnce(page(0, 10, 2)).mockImplementationOnce(() => new Promise((r) => { resolve = r; }));
      show();
      await screen.findAllByRole('listitem');
      act(() => { fire?.(); fire?.(); });
      expect(screen.getByText('Loading…')).toBeTruthy();
      expect(api.forgeForks).toHaveBeenCalledTimes(2); // page 1 and one page 2
      await act(async () => { resolve(page(10, 3, null)); });
      await waitFor(() => expect(rows()).toHaveLength(13));
      vi.unstubAllGlobals();
    });

    it('keeps what is loaded when a page fails and retries', async () => {
      api.forgeForks.mockResolvedValueOnce(page(0, 10, 2)).mockRejectedValueOnce({ message: 'boom' }).mockResolvedValueOnce(page(10, 2, null));
      show();
      await screen.findAllByRole('listitem');
      fireEvent.click(screen.getByRole('button', { name: 'Load more forks' }));
      expect((await screen.findByRole('alert')).textContent).toContain("Couldn't load more forks: boom");
      expect(rows()).toHaveLength(10);
      fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
      await waitFor(() => expect(rows()).toHaveLength(12));
    });
  });
});
