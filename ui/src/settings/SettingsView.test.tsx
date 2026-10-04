import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS, EMPTY_PROFILE } from '../app/state';
import { armClock, press } from '../ui/arm/armTesting';

const api = vi.hoisted(() => ({
  forgeAccounts: vi.fn(async () => []),
  saveSettings: vi.fn(async () => null),
  saveProfile: vi.fn(async () => null),
  pickFolder: vi.fn(async () => null),
  listOpeners: vi.fn(async () => [
    { id: 'vscode', name: 'Visual Studio Code', kind: 'editor' },
    { id: 'files', name: 'Files', kind: 'fileManager' },
  ]),
  validateEditorTemplate: vi.fn(async (t: string) => {
    if (t.startsWith('sh -c')) throw new Error("a shell or interpreter's code argument can't contain {file}, {line} or {repo}");
    return null;
  }),
}));
vi.mock('../api/client', () => ({ api, errorMessage: (e: unknown) => (e instanceof Error ? e.message : String(e)) }));
vi.mock('../api/transport', () => ({ copyText: vi.fn(async () => {}), inTauri: () => false }));

const { SettingsView } = await import('./SettingsView');
const { useSettingsUi, SETTINGS } = await import('./schema');
const { useAppState } = await import('../app/state');
const { useDensity } = await import('../theme/density');
const { useEditorSettings, STICKY_SCROLL_NOTE } = await import('../diff/editorSettings');
const { resetOpenersForTests } = await import('../openIn/openers');
const { useRuntime } = await import('../app/runtime');
const { ConfirmDialog } = await import('../ui/ConfirmDialog');
const { avatars } = await import('../avatars/avatarStore');
const { registerKeys } = await import('../ui/keyRouter');
const { ContextMenu } = await import('../menu/ContextMenu');
const { useMenu } = await import('../menu/menuStore');

const tab = { id: 't1', kind: 'repo' as const, path: '/r/shop', alias: null };
function show(focus?: string) {
  render(<><SettingsView /><ConfirmDialog /><ContextMenu /></>);
  act(() => useSettingsUi.getState().show(focus));
  return screen.getByRole('dialog', { name: 'Settings' });
}

beforeEach(() => {
  vi.clearAllMocks();
  Element.prototype.scrollIntoView = vi.fn();
  resetOpenersForTests();
  localStorage.clear();
  useDensity.getState().reload();
  useEditorSettings.setState({ settings: { stickyScroll: false } });
  useAppState.setState({ settings: DEFAULT_SETTINGS, profile: { ...EMPTY_PROFILE, name: 'Work', tabs: [tab], activeTab: 't1' } });
  useRuntime.setState({
    tabs: { t1: { status: 'ready', error: null, repo: { id: 7, name: 'shop', path: '/r/shop' } as never, graph: null, sidebar: null, lastFetchAt: 0, fetchSkipped: null, limit: null, worktree: null,
      info: { remotes: [{ name: 'origin', url: 'u', host: 'code.example.com', path: 'acme/shop', hostKind: 'generic' }] } as never } },
  });
});
afterEach(() => { act(() => { useSettingsUi.getState().close(); useSettingsUi.getState().setSection('General'); useMenu.getState().close(); }); });

/** Opens the dropdown button by its name and picks one of its rows. */
function pick(button: string, row: string) {
  fireEvent.click(screen.getByRole('button', { name: button }));
  fireEvent.click(screen.getByRole('menuitem', { name: row }));
}
const tabTo = (name: string) => fireEvent.click(screen.getByRole('button', { name }));

describe('SettingsView', () => {
  it('lists every setting of the schema that applies, under its sections, and nothing when closed', () => {
    const { container } = render(<SettingsView />);
    expect(container.innerHTML).toBe('');
    act(() => useSettingsUi.getState().show());
    const dialog = screen.getByRole('dialog', { name: 'Settings' });
    for (const sec of ['General', 'Appearance', 'Fetch', 'Editor', 'Profile', 'Hosts', 'Repository']) {
      tabTo(sec);
      for (const s of SETTINGS.filter((d) => d.section === sec)) expect(dialog.querySelector(`[data-setting-id="${s.id}"]`), s.id).not.toBeNull();
    }
  });

  it('hides the Repository section without a repository', () => {
    useRuntime.setState({ tabs: {} });
    const dialog = show();
    expect(dialog.querySelector('[data-setting-id="repoEditor"]')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Repository' })).toBeNull();
  });

  it('density is a three-way radio over the density store, persisted', () => {
    const dialog = show();
    expect(screen.getByRole('radio', { name: 'Standard' })).toBeChecked();
    fireEvent.click(screen.getByRole('radio', { name: 'Compact' }));
    expect(useDensity.getState().density).toBe('compact');
    expect(localStorage.getItem('gitbolt.density.v1')).toBe('compact');
    expect(dialog.querySelectorAll('input[name="density"]')).toHaveLength(3);
  });

  it('sticky scroll toggles the editor setting and its tooltip is the note, shown at once', () => {
    show('stickyScroll');
    const box = screen.getByLabelText('Sticky scroll in the diff viewer');
    expect(box).not.toBeChecked();
    fireEvent.click(box);
    expect(useEditorSettings.getState().settings.stickyScroll).toBe(true);
    expect(JSON.parse(localStorage.getItem('gitbolt.editorSettings.v1')!)).toEqual({ stickyScroll: true });
    fireEvent.mouseEnter(screen.getByText('Sticky scroll in the diff viewer'));
    expect(screen.getByText(STICKY_SCROLL_NOTE)).toBeInTheDocument();
  });

  it('the date format and prune write the app settings', () => {
    show();
    pick('Date format', '2026-09-26 15:14');
    expect(useAppState.getState().settings.dateFormat).toBe('ymd24h');
    tabTo('Fetch');
    fireEvent.click(screen.getByLabelText('Prune deleted remote branches on fetch'));
    expect(useAppState.getState().settings.prune).toBe(false);
    pick('Background fetch interval', 'Off');
    expect(useAppState.getState().settings.fetchIntervalSecs).toBe(0);
  });

  it('Push tags with branches writes the app setting, off by default', () => {
    show();
    tabTo('Fetch');
    const box = screen.getByLabelText('Push tags with branches');
    expect(box).not.toBeChecked();
    fireEvent.click(box);
    expect(useAppState.getState().settings.pushFollowTags).toBe(true);
  });

  it('shows a hand-edited fetch interval clamped', () => {
    useAppState.setState({ settings: { ...DEFAULT_SETTINGS, fetchIntervalSecs: 1 } });
    show('fetchInterval');
    expect(screen.getByLabelText('Background fetch interval')).toHaveTextContent('Every minute');
  });

  it('the commit limit applies on Enter, clamped, not per keystroke', () => {
    show();
    const input = screen.getByLabelText('Commits loaded in the graph');
    fireEvent.change(input, { target: { value: '3' } });
    expect(useAppState.getState().settings.commitLimit).toBe(2000);
    fireEvent.submit(input.closest('form')!);
    expect(useAppState.getState().settings.commitLimit).toBe(3);
    fireEvent.change(input, { target: { value: '999999' } });
    fireEvent.blur(input);
    expect(useAppState.getState().settings.commitLimit).toBe(50_000);
  });

  it('the Gravatar toggle saves the setting, then makes the avatars ask again', async () => {
    const reset = vi.spyOn(avatars, 'reset');
    show();
    fireEvent.click(screen.getByLabelText('Load avatars from Gravatar'));
    expect(useAppState.getState().settings.gravatar).toBe(false);
    await waitFor(() => expect(reset).toHaveBeenCalled());
    expect(api.saveSettings).toHaveBeenCalledWith(expect.objectContaining({ gravatar: false }));
  });

  it('picks a detected editor, and a Custom command that the guard refuses shows its error inline and is not saved', async () => {
    show('editor');
    await waitFor(() => expect(api.listOpeners).toHaveBeenCalled());
    await act(async () => {});
    pick('Default editor', 'Visual Studio Code');
    expect(useAppState.getState().profile.editor).toEqual({ kind: 'opener', id: 'vscode' });

    pick('Default editor', 'Custom command…');
    const command = screen.getByLabelText('Custom editor command');
    fireEvent.change(command, { target: { value: 'sh -c "geany {file}"' } });
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent("can't contain {file}, {line} or {repo}");
    expect(useAppState.getState().profile.editor).toEqual({ kind: 'opener', id: 'vscode' });

    fireEvent.change(command, { target: { value: 'subl {file}:{line}' } });
    await waitFor(() => expect(useAppState.getState().profile.editor).toEqual({ kind: 'custom', template: 'subl {file}:{line}' }));
    expect(screen.queryByRole('alert')).toBeNull();
    // Not clobbered by the echo of its own save.
    expect(command).toHaveValue('subl {file}:{line}');
  });

  it("the repository's editor override is its own, and 'Same as the profile' clears it", () => {
    show('repoEditor');
    pick('Editor for this repository', 'Custom command…');
    pick('Editor for this repository', 'Same as the profile');
    expect(useAppState.getState().profile.repos['/r/shop']?.editor ?? null).toBeNull();
  });

  it('host overrides: set one for a detected host, clear it, or add a host by hand', () => {
    show('hostOverrides');
    const select = screen.getByLabelText('Forge type for code.example.com');
    expect(select).toHaveTextContent('Detected (Generic)');
    pick('Forge type for code.example.com', 'GitLab');
    expect(useAppState.getState().profile.hostOverrides).toEqual({ 'code.example.com': 'gitlab' });
    pick('Forge type for code.example.com', 'Detected (Generic)');
    expect(useAppState.getState().profile.hostOverrides).toEqual({});

    fireEvent.change(screen.getByLabelText('Add a host'), { target: { value: 'https://Git.Corp.example/x' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    expect(useAppState.getState().profile.hostOverrides).toEqual({ 'git.corp.example': 'gitlab' });
  });

  it('the extra gitconfig path and the repos folder save on Enter', () => {
    show('extraGitconfig');
    const gitconfig = screen.getByLabelText('Extra git config for this profile');
    fireEvent.change(gitconfig, { target: { value: ' /home/u/.gitconfig-work ' } });
    fireEvent.submit(gitconfig.closest('form')!);
    expect(useAppState.getState().profile.extraGitconfig).toBe('/home/u/.gitconfig-work');
    fireEvent.change(gitconfig, { target: { value: '' } });
    fireEvent.blur(gitconfig);
    expect(useAppState.getState().profile.extraGitconfig).toBeNull();
  });

  it('reset asks first (Cancel changes nothing), then restores the defaults it owns', async () => {
    useAppState.setState({ settings: { ...DEFAULT_SETTINGS, dateFormat: 'dmy24h', prune: false, fetchIntervalSecs: 0 } });
    useDensity.getState().setDensity('compact');
    show();
    fireEvent.click(screen.getByRole('button', { name: /Reset settings to defaults/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));
    expect(useAppState.getState().settings.dateFormat).toBe('dmy24h');
    fireEvent.click(screen.getByRole('button', { name: /Reset settings to defaults/ }));
    // A fresh press past the settle answers it (spec §ui confirms).
    const clock = armClock();
    const reset = await screen.findByRole('button', { name: 'Reset' });
    clock.settle();
    press(reset);
    clock.restore();
    await waitFor(() => expect(useAppState.getState().settings.dateFormat).toBe('ymd12h'));
    expect(useAppState.getState().settings.prune).toBe(true);
    expect(useAppState.getState().settings.fetchIntervalSecs).toBe(60);
    expect(useDensity.getState().density).toBe('standard');
  });

  it('Escape closes it, and Ctrl+W typed in its fields never reaches the app', () => {
    const app = vi.fn();
    const off = registerKeys('app', app);
    show();
    const input = screen.getByLabelText('Commits loaded in the graph');
    fireEvent.keyDown(input, { key: 'w', code: 'KeyW', ctrlKey: true });
    expect(app).not.toHaveBeenCalled();
    expect(useSettingsUi.getState().open).toBe(true);
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(useSettingsUi.getState().open).toBe(false);
    expect(app).not.toHaveBeenCalled();
    off();
  });

  it("a window blur (the WM's focus bounce) doesn't commit a field mid-edit; a real blur does", () => {
    show('commitLimit');
    const input = screen.getByLabelText('Commits loaded in the graph');
    fireEvent.change(input, { target: { value: '77' } });
    const hasFocus = vi.spyOn(document, 'hasFocus').mockReturnValue(false);
    fireEvent.blur(input);
    expect(useAppState.getState().settings.commitLimit).toBe(2000);
    hasFocus.mockReturnValue(true);
    fireEvent.blur(input);
    expect(useAppState.getState().settings.commitLimit).toBe(77);
    hasFocus.mockRestore();
  });

  it('opened for one setting it shows that tab, focuses the control and flashes the row', () => {
    Element.prototype.scrollIntoView = vi.fn();
    const dialog = show('prune');
    expect(screen.getByRole('button', { name: 'Fetch' })).toHaveAttribute('aria-current', 'true');
    expect(dialog.querySelector('[data-section="General"]')).toBeNull();
    expect(screen.getByLabelText('Prune deleted remote branches on fetch')).toHaveFocus();
    expect(dialog.querySelector('[data-setting-id="prune"]')).toHaveClass('flash');
  });

  describe('tabs', () => {
    it('show one section at a time, and the tab is kept for the session', () => {
      const dialog = show();
      expect(dialog.querySelectorAll('[data-section]')).toHaveLength(1);
      tabTo('Editor');
      expect(dialog.querySelector('[data-section="Editor"]')).not.toBeNull();
      expect(dialog.querySelector('[data-section="General"]')).toBeNull();
      expect(screen.getByRole('button', { name: 'Editor' })).toHaveAttribute('aria-current', 'true');
      act(() => useSettingsUi.getState().close());
      act(() => useSettingsUi.getState().show());
      expect(screen.getByRole('dialog', { name: 'Settings' }).querySelector('[data-section="Editor"]')).not.toBeNull();
    });
  });

  describe('dropdown', () => {
    it('clicking the setting label does not open the dropdown (K103)', () => {
      const dialog = show();
      const btn = screen.getByRole('button', { name: 'Date format' });
      fireEvent.click(dialog.querySelector('#label-dateFormat')!);
      expect(btn).toHaveAttribute('aria-expanded', 'false');
      expect(screen.queryByRole('menu')).toBeNull();
    });

    it('opens on click with the current value checked, selects a row, and closes', () => {
      show();
      const btn = screen.getByRole('button', { name: 'Date format' });
      expect(btn).toHaveTextContent('2026-09-26 @ 3:14 PM');
      fireEvent.click(btn);
      expect(btn).toHaveAttribute('aria-expanded', 'true');
      expect(screen.getAllByRole('menuitem')).toHaveLength(4);
      fireEvent.click(screen.getByRole('menuitem', { name: '26/09/2026 15:14' }));
      expect(useAppState.getState().settings.dateFormat).toBe('dmy24h');
      expect(screen.queryByRole('menu')).toBeNull();
      expect(btn).toHaveTextContent('26/09/2026 15:14');
    });

    it('opens with ArrowDown, moves with the arrows, Enter selects; Esc closes only the menu and returns focus', () => {
      show();
      const btn = screen.getByRole('button', { name: 'Date format' });
      act(() => btn.focus());
      fireEvent.keyDown(btn, { key: 'ArrowDown' });
      expect(screen.getByRole('menu')).toBeInTheDocument();
      fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });
      expect(screen.queryByRole('menu')).toBeNull();
      expect(useSettingsUi.getState().open).toBe(true);
      expect(btn).toHaveFocus();
      fireEvent.keyDown(btn, { key: 'ArrowDown' });
      fireEvent.keyDown(screen.getByRole('menu'), { key: 'ArrowDown' });
      fireEvent.keyDown(screen.getByRole('menu'), { key: 'Enter' });
      expect(useAppState.getState().settings.dateFormat).toBe('ymd24h');
      expect(btn).toHaveFocus();
    });

    it('Enter on the focused button opens it too (its click)', () => {
      show();
      fireEvent.click(screen.getByRole('button', { name: 'Date format' }));
      expect(screen.getByRole('menu')).toBeInTheDocument();
    });
  });
  // --- 4A T11 ---
  it('Accounts is a section of its own, titled with the profile, and deep links reach it', async () => {
    show('forgeAccounts');
    expect(screen.getByRole('region', { name: 'Accounts' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Accounts (Work)' })).toBeTruthy();
    await waitFor(() => expect(api.forgeAccounts).toHaveBeenCalled());
  });

  it('the forge avatars switch saves and asks for every avatar again', async () => {
    const reset = vi.spyOn(avatars, 'reset');
    show('forgeAvatars');
    fireEvent.click(screen.getByLabelText('Load avatars from your forge accounts'));
    expect(useAppState.getState().settings.forgeAvatars).toBe(false);
    await waitFor(() => expect(reset).toHaveBeenCalled());
  });
  // --- end 4A T11 ---
});
