import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ForgeAccountView } from '../api/gen/ForgeAccountView';
import { DEFAULT_SETTINGS, EMPTY_PROFILE } from '../app/state';
import { armClock, press } from '../ui/arm/armTesting';

const TOKEN = 'glpat-FAKE-test-token';
const ada = (storage: 'keyring' | 'file', status: ForgeAccountView['status'] = { kind: 'ok' }): ForgeAccountView => ({
  account: { host: 'gitlab.example.com', kind: 'gitlab', user: { id: 7, username: 'ada', name: 'Ada Lovelace', avatarUrl: null, webUrl: 'https://gitlab.example.com/ada', email: 'ada@example.com' }, storage, version: '18.9.1-ee', versionCheckedAt: 0, addedAt: 0 },
  status,
});

const api = vi.hoisted(() => ({
  forgeAccounts: vi.fn(async (): Promise<unknown[]> => []),
  addForgeAccount: vi.fn(async (): Promise<unknown> => ({})),
  removeForgeAccount: vi.fn(async () => null),
  forgeTokenPage: vi.fn(async (host: string) => `https://${host}/new-token`),
  openUrl: vi.fn(async () => null),
  avatar: vi.fn(async () => null),
}));
vi.mock('../api/client', () => ({ api, errorMessage: (e: unknown) => (e && typeof e === 'object' && 'message' in e ? String((e as { message: unknown }).message) : String(e)) }));
vi.mock('../api/transport', () => ({ copyText: vi.fn(async () => {}), inTauri: () => false }));

const { AccountsSection, FILE_WARNING, statusText } = await import('./AccountsSection');
const { useAppState } = await import('../app/state');
const { useRuntime } = await import('../app/runtime');
const { ConfirmDialog } = await import('../ui/ConfirmDialog');
const { avatars } = await import('../avatars/avatarStore');

const show = () => render(<><AccountsSection /><ConfirmDialog /></>);
const row = () => screen.findByRole('listitem', { name: 'gitlab.example.com account' });

beforeEach(() => {
  vi.clearAllMocks();
  api.forgeAccounts.mockResolvedValue([]);
  useAppState.setState({ settings: DEFAULT_SETTINGS, profile: { ...EMPTY_PROFILE, name: 'Work', tabs: [{ id: 't1', kind: 'repo', path: '/r/shop', alias: null }], activeTab: 't1' } });
  useRuntime.setState({
    tabs: { t1: { status: 'ready', error: null, repo: { id: 7, name: 'shop', path: '/r/shop' } as never, graph: null, sidebar: null, lastFetchAt: 0, fetchSkipped: null, limit: null, worktree: null,
      info: { remotes: [{ name: 'origin', url: 'https://gitlab.example.com/group/project.git', host: 'gitlab.example.com', path: 'group/project', hostKind: 'gitlab' }] } as never } } as never,
  });
});

describe('Settings › Accounts', () => {
  it('lists an account with its user, forge, version and storage', async () => {
    api.forgeAccounts.mockResolvedValue([ada('keyring')]);
    show();
    const r = await row();
    expect(r.textContent).toContain('Ada Lovelace');
    expect(r.textContent).toContain('@ada · gitlab.example.com · GitLab 18.9.1-ee');
    expect(r.textContent).toContain('System keyring');
    expect(r.textContent).not.toContain(FILE_WARNING);
  });

  it('a file-stored account shows the not-secure warning', async () => {
    api.forgeAccounts.mockResolvedValue([ada('file')]);
    show();
    const r = await row();
    expect(r.textContent).toContain('File — not secure');
    expect(r.textContent).toContain(FILE_WARNING);
  });

  it('says a status in plain words', () => {
    expect(statusText(ada('keyring'))).toBeNull();
    expect(statusText(ada('keyring', { kind: 'tokenMissing' }))).toBe('Token missing: add the account again');
    expect(statusText(ada('keyring', { kind: 'unreachable', message: "Couldn't reach gitlab.example.com: timed out" }))).toBe("Couldn't reach gitlab.example.com: timed out");
    expect(statusText(ada('keyring', { kind: 'rateLimited', until: 1_791_115_200 }))).toMatch(/^Rate limited until \d{1,2}:\d{2}/);
  });

  it("adds an account for the open repo's host, then forgets the token it was given", async () => {
    show();
    await waitFor(() => expect((screen.getByLabelText('Host') as HTMLInputElement).value).toBe('gitlab.example.com'));
    fireEvent.change(screen.getByLabelText('Token'), { target: { value: TOKEN } });
    api.forgeAccounts.mockResolvedValue([ada('keyring')]);
    const reset = vi.spyOn(avatars, 'reset');
    fireEvent.click(screen.getByRole('button', { name: 'Add account' }));
    await waitFor(() => expect(api.addForgeAccount).toHaveBeenCalledWith('gitlab.example.com', 'gitlab', TOKEN));
    await row();
    expect((screen.getByLabelText('Token') as HTMLInputElement).value).toBe('');
    expect(document.body.innerHTML).not.toContain(TOKEN);
    expect(reset).toHaveBeenCalled();
  });

  it('a refused token says why and keeps what was typed', async () => {
    api.addForgeAccount.mockRejectedValueOnce({ kind: 'AuthFailed', message: 'gitlab.example.com rejected this token: check that you copied all of it', commandId: null, stderr: null });
    show();
    fireEvent.change(await screen.findByLabelText('Token'), { target: { value: TOKEN } });
    fireEvent.click(screen.getByRole('button', { name: 'Add account' }));
    expect((await screen.findByRole('alert')).textContent).toBe('gitlab.example.com rejected this token: check that you copied all of it');
    expect((screen.getByLabelText('Token') as HTMLInputElement).value).toBe(TOKEN);
  });

  it("Create token opens the forge's prefilled page, GitHub for github.com", async () => {
    show();
    await waitFor(() => expect((screen.getByLabelText('Host') as HTMLInputElement).value).toBe('gitlab.example.com'));
    fireEvent.click(screen.getByRole('button', { name: 'Create token' }));
    await waitFor(() => expect(api.openUrl).toHaveBeenCalledWith('https://gitlab.example.com/new-token'));
    expect(api.forgeTokenPage).toHaveBeenLastCalledWith('gitlab.example.com', 'gitlab');
    fireEvent.change(screen.getByLabelText('Host'), { target: { value: 'github.com' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create token' }));
    await waitFor(() => expect(api.forgeTokenPage).toHaveBeenLastCalledWith('github.com', 'github'));
  });

  it('Remove asks first, then removes the account', async () => {
    api.forgeAccounts.mockResolvedValue([ada('keyring')]);
    show();
    fireEvent.click(await screen.findByRole('button', { name: 'Remove the gitlab.example.com account' }));
    const clock = armClock();
    const confirm = await screen.findByRole('button', { name: 'Remove account' });
    clock.settle();
    press(confirm);
    clock.restore();
    await waitFor(() => expect(api.removeForgeAccount).toHaveBeenCalledWith('gitlab.example.com'));
  });

  it('while checking, the button reads Checking… and a second submit is ignored', async () => {
    let done!: (v: unknown) => void;
    api.addForgeAccount.mockReturnValueOnce(new Promise((r) => { done = r; }));
    show();
    fireEvent.change(await screen.findByLabelText('Token'), { target: { value: TOKEN } });
    const btn = screen.getByRole('button', { name: 'Add account' });
    fireEvent.click(btn);
    const busy = await screen.findByRole('button', { name: 'Checking…' });
    expect((busy as HTMLButtonElement).disabled).toBe(true);
    fireEvent.submit(screen.getByRole('form', { name: 'Add a forge account' }));
    expect(api.addForgeAccount).toHaveBeenCalledTimes(1);
    api.forgeAccounts.mockResolvedValue([ada('keyring')]);
    done(ada('keyring'));
    await row();
  });

  it('a host override decides the kind sent for an unknown host', async () => {
    useAppState.setState({ profile: { ...useAppState.getState().profile, hostOverrides: { 'git.corp.example': 'github' } } });
    show();
    fireEvent.change(await screen.findByLabelText('Host'), { target: { value: 'git.corp.example' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create token' }));
    await waitFor(() => expect(api.forgeTokenPage).toHaveBeenLastCalledWith('git.corp.example', 'github'));
  });
});
