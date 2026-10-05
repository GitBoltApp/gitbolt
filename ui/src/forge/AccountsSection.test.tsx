import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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
const polling = vi.hoisted(() => ({ notifyForgeAccountsChanged: vi.fn() }));
vi.mock('./accountsBus', () => polling);
vi.mock('../api/transport', () => ({ copyText: vi.fn(async () => {}), inTauri: () => false }));

const { AccountsSection, FILE_WARNING, statusText, statusChip } = await import('./AccountsSection');
const { useAppState } = await import('../app/state');
const { useRuntime } = await import('../app/runtime');
const { ConfirmDialog } = await import('../ui/ConfirmDialog');
const { avatars } = await import('../avatars/avatarStore');

const show = () => render(<><AccountsSection /><ConfirmDialog /></>);
const openAdd = async () => { fireEvent.click(await screen.findByRole('button', { name: '+ Add account' })); await screen.findByRole('form', { name: 'Add a forge account' }); };
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
    expect(r.textContent).toContain('@ada');
    expect(r.textContent).toContain('gitlab.example.com · GitLab 18.9.1-ee');
    expect(r.textContent).toContain('● Connected');
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
    expect(statusText(ada('keyring', { kind: 'tokenMissing' }))).toBe('Token missing: replace it to reconnect');
    expect(statusText(ada('keyring', { kind: 'unreachable', message: "Couldn't reach gitlab.example.com: timed out" }))).toBe("Couldn't reach gitlab.example.com: timed out");
    expect(statusText(ada('keyring', { kind: 'rateLimited', until: 1_791_115_200 }))).toMatch(/^Rate limited until \d{1,2}:\d{2}/);
  });

  it('the empty state offers Add account, and the panel opens and cancels with the focus back on the button', async () => {
    show();
    expect(await screen.findByText('No accounts yet.')).toBeTruthy();
    expect(screen.getByText(/Tokens are kept in the system keyring/)).toBeTruthy();
    await openAdd();
    expect(screen.queryByRole('button', { name: '+ Add account' })).toBeNull();
    fireEvent.change(screen.getByLabelText('Token'), { target: { value: TOKEN } });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('form')).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: '+ Add account' })));
    await openAdd();
    expect((screen.getByLabelText('Token') as HTMLInputElement).value).toBe('');
  });

  it('a suggestion picked from the combobox fills the host, with its source dimmed; taken hosts are left out', async () => {
    useRuntime.setState({
      tabs: { t1: { ...useRuntime.getState().tabs.t1, info: { remotes: [
        { name: 'origin', url: 'u', host: 'gitlab.example.com', path: 'g/p', hostKind: 'gitlab' },
        { name: 'upstream', url: 'u2', host: 'github.com', path: 'o/p', hostKind: 'github' },
        { name: 'taken', url: 'u3', host: 'taken.example.com', path: 'o/p', hostKind: 'gitlab' },
      ] } as never } } as never,
    });
    api.forgeAccounts.mockResolvedValue([{ ...ada('keyring'), account: { ...ada('keyring').account, host: 'taken.example.com' } }]);
    show();
    await screen.findByRole('listitem', { name: 'taken.example.com account' });
    fireEvent.click(screen.getByRole('button', { name: '+ Add account' }));
    const host = await screen.findByLabelText('Host');
    fireEvent.focus(host);
    const list = await screen.findByRole('listbox');
    expect(list.textContent).toContain('origin · shop');
    expect(list.textContent).not.toContain('taken.example.com');
    fireEvent.keyDown(host, { key: 'ArrowDown' });
    fireEvent.keyDown(host, { key: 'Enter' });
    expect((host as HTMLInputElement).value).toBe('github.com');
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(screen.getByRole('button', { name: 'GitHub' }).getAttribute('aria-pressed')).toBe('true');
  });

  it('the forge is detected from the host and can be overridden (a typed host stays)', async () => {
    show();
    await openAdd();
    expect(screen.getByRole('button', { name: 'GitLab' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByText('Detected from the host')).toBeTruthy();
    // A self-hosted forge on an unusual name: the host is typed, so picking the forge keeps it.
    fireEvent.change(screen.getByRole('combobox', { name: 'Host' }), { target: { value: 'code.example.org' } });
    fireEvent.click(screen.getByRole('button', { name: 'GitHub' }));
    expect(screen.getByRole('button', { name: 'GitHub' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.queryByText('Detected from the host')).toBeNull();
    fireEvent.change(screen.getByLabelText('Token'), { target: { value: TOKEN } });
    fireEvent.click(screen.getByRole('button', { name: 'Add account' }));
    await waitFor(() => expect(api.addForgeAccount).toHaveBeenCalledWith('code.example.org', 'github', TOKEN));
  });

  it('Replace token opens the panel for that host (read-only) and re-adds it', async () => {
    api.forgeAccounts.mockResolvedValue([ada('keyring', { kind: 'authFailed', message: 'gitlab.example.com rejected the token: it may have expired.' })]);
    show();
    expect((await row()).textContent).toContain('Replace it to reconnect');
    fireEvent.click(screen.getByRole('button', { name: 'Replace the token for gitlab.example.com' }));
    const form = await screen.findByRole('form', { name: 'Replace the token for gitlab.example.com' });
    expect(form).toBeTruthy();
    expect((screen.getByLabelText('Host') as HTMLInputElement).readOnly).toBe(true);
    expect((screen.getByLabelText('Host') as HTMLInputElement).value).toBe('gitlab.example.com');
    fireEvent.change(screen.getByLabelText('Token'), { target: { value: TOKEN } });
    fireEvent.click(screen.getByRole('button', { name: 'Replace token' }));
    await waitFor(() => expect(api.addForgeAccount).toHaveBeenCalledWith('gitlab.example.com', 'gitlab', TOKEN));
    await waitFor(() => expect(screen.queryByRole('form')).toBeNull());
    expect(polling.notifyForgeAccountsChanged).toHaveBeenCalledTimes(1);
    expect(document.body.innerHTML).not.toContain(TOKEN);
  });

  it('picking GitHub with no GitHub remote fills github.com; a host with an account offers Replace its token', async () => {
    api.forgeAccounts.mockResolvedValue([{ ...ada('keyring'), account: { ...ada('keyring').account, host: 'github.com', kind: 'github' } }]);
    show();
    await openAdd();
    const form = screen.getByRole('form', { name: 'Add a forge account' });
    expect(within(form).getByRole('combobox', { name: 'Host' })).toHaveValue('gitlab.example.com');
    fireEvent.click(within(form).getByRole('button', { name: 'GitHub' }));
    expect(within(form).getByRole('combobox', { name: 'Host' })).toHaveValue('github.com');
    expect(within(form).getByRole('status')).toHaveTextContent('github.com already has an account.');
    expect(within(form).getByRole('button', { name: /Create token on github.com/ })).toBeDisabled();
    fireEvent.click(within(form).getByRole('button', { name: 'Replace its token' }));
    expect(await screen.findByRole('form', { name: 'Replace the token for github.com' })).toBeInTheDocument();
  });

  it('with no host, Create token is visibly disabled and says why', async () => {
    useRuntime.setState({ tabs: {} as never });
    show();
    await openAdd();
    const create = within(screen.getByRole('form', { name: 'Add a forge account' })).getByRole('button', { name: /Create token on the host/ });
    expect(create).toBeDisabled();
    expect(create).toHaveAttribute('title', 'Enter the host first');
  });

  it('the status and storage chips say ok, file, token rejected and rate limited', () => {
    expect(statusChip(ada('keyring'))).toEqual({ tone: 'ok', label: 'Connected' });
    expect(statusChip(ada('keyring', { kind: 'authFailed', message: 'x' }))).toEqual({ tone: 'err', label: 'Token rejected' });
    expect(statusChip(ada('keyring', { kind: 'unreachable', message: 'x' }))).toEqual({ tone: 'err', label: 'Unreachable' });
    expect(statusChip(ada('keyring', { kind: 'tokenMissing' }))).toEqual({ tone: 'err', label: 'Token missing' });
    const limited = statusChip(ada('keyring', { kind: 'rateLimited', until: 1_791_115_200 }));
    expect(limited.tone).toBe('warn');
    expect(limited.label).toMatch(/^Rate limited until \d{1,2}:\d{2}/);
  });

  it("adds an account for the open repo's host, then forgets the token it was given", async () => {
    show();
    await openAdd();
    await waitFor(() => expect((screen.getByLabelText('Host') as HTMLInputElement).value).toBe('gitlab.example.com'));
    fireEvent.change(screen.getByLabelText('Token'), { target: { value: TOKEN } });
    api.forgeAccounts.mockResolvedValue([ada('keyring')]);
    const reset = vi.spyOn(avatars, 'reset');
    fireEvent.click(screen.getByRole('button', { name: 'Add account' }));
    await waitFor(() => expect(api.addForgeAccount).toHaveBeenCalledWith('gitlab.example.com', 'gitlab', TOKEN));
    await row();
    expect(screen.queryByRole('form')).toBeNull();
    expect(document.body.innerHTML).not.toContain(TOKEN);
    expect(reset).toHaveBeenCalled();
    expect(polling.notifyForgeAccountsChanged).toHaveBeenCalledTimes(1);
  });

  it('a refused token says why and keeps what was typed', async () => {
    api.addForgeAccount.mockRejectedValueOnce({ kind: 'AuthFailed', message: 'gitlab.example.com rejected this token: check that you copied all of it', commandId: null, stderr: null });
    show();
    await openAdd();
    fireEvent.change(await screen.findByLabelText('Token'), { target: { value: TOKEN } });
    fireEvent.click(screen.getByRole('button', { name: 'Add account' }));
    expect((await screen.findByRole('alert')).textContent).toBe('gitlab.example.com rejected this token: check that you copied all of it');
    expect((screen.getByLabelText('Token') as HTMLInputElement).value).toBe(TOKEN);
  });

  it("Create token opens the forge's prefilled page, GitHub for github.com", async () => {
    show();
    await openAdd();
    fireEvent.click(screen.getByRole('button', { name: /^Create token on/ }));
    await waitFor(() => expect(api.openUrl).toHaveBeenCalledWith('https://gitlab.example.com/new-token'));
    expect(api.forgeTokenPage).toHaveBeenLastCalledWith('gitlab.example.com', 'gitlab', undefined);
    fireEvent.change(screen.getByLabelText('Host'), { target: { value: 'github.com' } });
    fireEvent.click(screen.getByRole('button', { name: /^Create token on/ }));
    await waitFor(() => expect(api.forgeTokenPage).toHaveBeenLastCalledWith('github.com', 'github', false));
  });

  it('the token type toggle shows only for GitHub and picks the classic page', async () => {
    show();
    await openAdd();
    expect(screen.queryByRole('group', { name: 'Token type' })).toBeNull();
    fireEvent.change(screen.getByLabelText('Host'), { target: { value: 'github.com' } });
    const group = await screen.findByRole('group', { name: 'Token type' });
    expect(screen.getByRole('button', { name: 'Fine-grained' }).getAttribute('aria-pressed')).toBe('true');
    expect(document.body.textContent).toContain('Some organizations cap these tokens');
    fireEvent.click(screen.getByRole('button', { name: 'Classic' }));
    expect(group.querySelector('.is-on')?.textContent).toBe('Classic');
    expect(document.body.textContent).toContain('repo and read:org scopes');
    fireEvent.click(screen.getByRole('button', { name: /^Create token on/ }));
    await waitFor(() => expect(api.forgeTokenPage).toHaveBeenLastCalledWith('github.com', 'github', true));
  });

  it('the org-policy refusal keeps its words and offers the classic switch', async () => {
    api.addForgeAccount.mockRejectedValueOnce({ message: "github.com refused: The 'acme' organization forbids access via a fine-grained personal access tokens if the token's lifetime is greater than 90 days" });
    show();
    await openAdd();
    fireEvent.change(screen.getByLabelText('Host'), { target: { value: 'github.com' } });
    fireEvent.change(screen.getByLabelText('Token'), { target: { value: 'ghp_test_not_real' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add account' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('forbids access via a fine-grained');
    fireEvent.click(screen.getByRole('button', { name: 'Use a classic token instead' }));
    expect(screen.getByRole('button', { name: 'Classic' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.queryByRole('button', { name: 'Use a classic token instead' })).toBeNull();
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
    await waitFor(() => expect(polling.notifyForgeAccountsChanged).toHaveBeenCalled());
  });

  it("a failed Remove keeps its error on screen after the list is read again, and the account's row", async () => {
    const message = "Couldn't delete the token for gitlab.example.com from the system keyring: access denied";
    api.forgeAccounts.mockResolvedValue([ada('keyring')]);
    api.removeForgeAccount.mockRejectedValueOnce({ kind: 'Other', message });
    show();
    fireEvent.click(await screen.findByRole('button', { name: 'Remove the gitlab.example.com account' }));
    const clock = armClock();
    const confirm = await screen.findByRole('button', { name: 'Remove account' });
    clock.settle();
    press(confirm);
    clock.restore();
    await waitFor(() => expect(api.forgeAccounts).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe(message));
    expect(await row()).toBeTruthy();
  });

  it('while checking, the button reads Checking… and a second submit is ignored', async () => {
    let done!: (v: unknown) => void;
    api.addForgeAccount.mockReturnValueOnce(new Promise((r) => { done = r; }));
    show();
    await openAdd();
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
    await openAdd();
    fireEvent.change(await screen.findByLabelText('Host'), { target: { value: 'git.corp.example' } });
    fireEvent.click(screen.getByRole('button', { name: /^Create token on/ }));
    await waitFor(() => expect(api.forgeTokenPage).toHaveBeenLastCalledWith('git.corp.example', 'github', false));
  });
});
