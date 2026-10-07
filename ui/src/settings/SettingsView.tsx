import { examplePath } from '../app/osPath';
import { X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api/client';
import type { DateFormat } from '../api/gen/DateFormat';
import type { HostKind } from '../api/gen/HostKind';
import { useModalKeys } from '../app/modalKeys';
import { useRuntime } from '../app/runtime';
import { EMPTY_REPO_SETTINGS, flushSaves, useAppState } from '../app/state';
import { resetAvatars } from '../avatars/avatarStore';
import { useFileListPrefs } from '../files/fileListPrefs';
import { DEFAULT_EDITOR_SETTINGS, useEditorSettings } from '../diff/editorSettings';
import { clampEditorFont, EDITOR_FONT_MAX, EDITOR_FONT_MIN } from '../diff/options';
import { HoverTooltip } from '../ui/HoverTooltip';
import { isWindowBlur, refocusWhenWindowReturns } from '../ui/windowBlur';
import { confirmAction } from '../ui/ConfirmDialog';
import { DEFAULT_DENSITY, DENSITIES, useDensity, type Density } from '../theme/density';
import { Select } from '../ui/Select';
import { AppearanceSection } from '../theme/AppearanceSection';
import { AccountsSection } from '../forge/AccountsSection';
import { EditorPicker } from './EditorPicker';
import { Row } from './Row';
import { clampFetchInterval, useSettingsUi, type SettingsSection } from './schema';
import './settings.css';

const SECTIONS: SettingsSection[] = ['General', 'Appearance', 'Fetch', 'Editor', 'Profile', 'Accounts', 'Hosts', 'Advanced', 'Repository'];
const FETCH_CHOICES: Array<[number, string]> = [[0, 'Off'], [60, 'Every minute'], [300, 'Every 5 minutes'], [600, 'Every 10 minutes'], [1800, 'Every 30 minutes']];
const DATE_CHOICES: Array<[DateFormat, string]> = [['ymd12h', '2026-09-26 @ 3:14 PM'], ['ymd24h', '2026-09-26 15:14'], ['dmy24h', '26/09/2026 15:14'], ['mdy12h', '09/26/2026 3:14 PM']];
const DENSITY_LABELS: Record<Density, [string, string]> = {
  compact: ['Compact', 'Tightest rows: the most commits on screen'],
  standard: ['Standard', 'The default: balanced rows'],
  comfortable: ['Comfortable', 'More padding around every row'],
};
const COMMIT_LIMIT_MAX = 50_000;
const DEFAULT_COMMIT_LIMIT = 2000;
const HOST_KINDS: Array<[HostKind, string]> = [['gitlab', 'GitLab'], ['github', 'GitHub'], ['generic', 'Generic (no forge links)']];
const KIND_NAMES: Record<HostKind, string> = { gitlab: 'GitLab', github: 'GitHub', generic: 'Generic' };

// Enter applies through the form (implicit submission): the dialog's key claim (`useModalKeys`)
// stops the keydown before React's handlers, so an `onKeyDown` here would never see it.

/** A number box that applies on Enter or blur (not per keystroke, which would reload the graph
 * for every digit), and snaps back to the applied value when what's typed isn't valid. */
function NumberField({ id, value, min, max, step, onCommit }: { id: string; value: number; min: number; max: number; step: number; onCommit(n: number): void }) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);
  const commit = () => {
    const n = Math.round(Number(draft));
    if (draft.trim() === '' || !Number.isFinite(n)) return setDraft(String(value));
    const clamped = Math.min(max, Math.max(min, n));
    setDraft(String(clamped));
    if (clamped !== value) onCommit(clamped);
  };
  return (
    <form className="inline-form" noValidate onSubmit={(e) => { e.preventDefault(); commit(); }}>
      <input id={`input-${id}`} type="number" min={min} max={max} step={step} value={draft} onChange={(e) => setDraft(e.target.value)} onBlur={(e) => { if (isWindowBlur()) return refocusWhenWindowReturns(e.currentTarget); commit(); }} />
    </form>
  );
}

/** A text box that applies on Enter or blur. */
function TextField({ id, value, placeholder, onCommit }: { id: string; value: string; placeholder?: string; onCommit(v: string): void }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const commit = () => { if (draft.trim() !== value) onCommit(draft.trim()); };
  return (
    <form className="inline-form" noValidate onSubmit={(e) => { e.preventDefault(); commit(); }}>
      <input id={`input-${id}`} spellCheck={false} value={draft} placeholder={placeholder} onChange={(e) => setDraft(e.target.value)} onBlur={(e) => { if (isWindowBlur()) return refocusWhenWindowReturns(e.currentTarget); commit(); }} />
    </form>
  );
}

function HostRows({ detected }: { detected: Array<[string, HostKind]> }) {
  const overrides = useAppState((s) => s.profile.hostOverrides);
  const updateProfile = useAppState((s) => s.updateProfile);
  const [added, setAdded] = useState('');
  const [addedKind, setAddedKind] = useState<HostKind>('gitlab');
  const hosts = useMemo(() => {
    const known = new Map(detected);
    for (const h of Object.keys(overrides)) if (!known.has(h)) known.set(h, 'generic');
    return [...known.entries()];
  }, [detected, overrides]);
  const set = (host: string, kind: HostKind | '') => updateProfile((p) => {
    const hostOverrides = { ...p.hostOverrides };
    if (kind) hostOverrides[host] = kind;
    else delete hostOverrides[host];
    return { ...p, hostOverrides };
  });
  const host = added.trim().toLowerCase().replace(/^[a-z]+:\/\//, '').replace(/\/.*$/, '');
  return (
    <div className="hosts-box">
      {hosts.length === 0 && <span className="dim">No remotes in the open repository. Add a host to set its type for every repository.</span>}
      {hosts.length > 0 && (
        <table className="hosts">
          <tbody>
            {hosts.map(([h, kind]) => (
              <tr key={h}>
                <td className="host-name">{h}</td>
                <td>
                  <Select<HostKind | ''> aria-label={`Forge type for ${h}`} value={overrides[h] ?? ''} onChange={(k) => set(h, k)} options={[['', `Detected (${KIND_NAMES[kind]})`], ...HOST_KINDS]} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <form className="host-add" onSubmit={(e) => { e.preventDefault(); if (host) { set(host, addedKind); setAdded(''); } }}>
        <input aria-label="Add a host" placeholder="git.example.com" spellCheck={false} value={added} onChange={(e) => setAdded(e.target.value)} />
        <Select<HostKind> aria-label="Forge type for the added host" value={addedKind} onChange={setAddedKind} options={HOST_KINDS} />
        <button type="submit" disabled={!host}>Add</button>
      </form>
    </div>
  );
}

/** The settings dialog (Ctrl+,): app-wide settings, the active profile's and the active repo's. */
export function SettingsView() {
  const open = useSettingsUi((s) => s.open);
  if (!open) return null;
  return <SettingsDialog />;
}

function SettingsDialog() {
  const focus = useSettingsUi((s) => s.focus);
  const close = useSettingsUi((s) => s.close);
  const settings = useAppState((s) => s.settings);
  const profile = useAppState((s) => s.profile);
  const setSettings = useAppState((s) => s.setSettings);
  const updateProfile = useAppState((s) => s.updateProfile);
  const updateRepo = useAppState((s) => s.updateRepo);
  const density = useDensity((s) => s.density);
  const advanceAfterStage = useFileListPrefs((s) => s.advanceAfterStage);
  const stickyScroll = useEditorSettings((s) => s.settings.stickyScroll);
  const rootRef = useModalKeys<HTMLDivElement>(true, close, 'Ctrl+,');
  const bodyRef = useRef<HTMLDivElement>(null);
  // The shown tab: the Repository settings are its, and so are the remotes the Hosts list offers.
  const activeTab = useAppState((s) => s.profile.activeTab);
  const rt = useRuntime((s) => (activeTab ? s.tabs[activeTab] : undefined));
  const repoPath = rt?.repo?.path ?? null;
  const repoSettings = repoPath ? profile.repos[repoPath] ?? EMPTY_REPO_SETTINGS : null;
  const detected = useMemo<Array<[string, HostKind]>>(() => (rt?.info?.remotes ?? []).flatMap((r) => (r.host ? [[r.host, r.hostKind] as [string, HostKind]] : [])), [rt?.info]);
  const sections = SECTIONS.filter((s) => s !== 'Repository' || repoPath);

  // The shown tab: the remembered one, or General when it isn't there (Repository without a repo).
  const stored = useSettingsUi((s) => s.section);
  const section = sections.includes(stored) ? stored : sections[0];

  useEffect(() => { bodyRef.current?.scrollTo?.(0, 0); }, [section]);

  // A deep link: its tab is already shown (`show`); focus the setting's control and flash its row.
  useEffect(() => {
    if (!focus) return;
    const el = bodyRef.current?.querySelector<HTMLElement>(`[data-setting-id="${focus}"]`);
    if (!el) return;
    (el.querySelector<HTMLElement>('input:checked, [id^="input-"]') ?? el.querySelector<HTMLElement>('button, input, select'))?.focus({ preventScroll: true });
    el.scrollIntoView({ block: 'center' });
    el.classList.add('flash');
    const t = setTimeout(() => el.classList.remove('flash'), 1500);
    return () => clearTimeout(t);
  }, [focus, section]);

  const changeCommitLimit = (n: number) => {
    setSettings({ commitLimit: n });
    const tab = useAppState.getState().profile.activeTab;
    if (tab && useRuntime.getState().tabs[tab]?.repo) void useRuntime.getState().refresh(tab);
  };
  const changeGravatar = (on: boolean) => {
    setSettings({ gravatar: on });
    // The backend learns the setting with the save; what it answers changes after that.
    void flushSaves().then(() => resetAvatars());
  };
  // --- 4A T11 ---
  const changeForgeAvatars = (on: boolean) => {
    setSettings({ forgeAvatars: on });
    void flushSaves().then(() => resetAvatars());
  };
  // --- end 4A T11 ---
  const resetAll = async () => {
    const ok = await confirmAction({
      title: 'Reset settings to their defaults?',
      body: 'Date format, commits loaded, density, avatars, background fetch, pruning and sticky scroll go back to how GitBolt ships. Your editor, git config and host settings stay.',
      confirmLabel: 'Reset',
      arm: 'Click again to reset every setting here to its default',
      danger: true,
    });
    if (!ok) return;
    changeGravatar(true);
    changeForgeAvatars(true);
    setSettings({ dateFormat: 'ymd12h', commitLimit: DEFAULT_COMMIT_LIMIT, fetchIntervalSecs: 60, prune: true });
    useDensity.getState().setDensity(DEFAULT_DENSITY);
    useEditorSettings.getState().set({ ...DEFAULT_EDITOR_SETTINGS });
    changeCommitLimit(DEFAULT_COMMIT_LIMIT);
  };

  const fetchSecs = clampFetchInterval(settings.fetchIntervalSecs);
  return (
    <div className="modal-backdrop" onPointerDown={close}>
      <div ref={rootRef} className="settings" role="dialog" aria-modal="true" aria-label="Settings" onPointerDown={(e) => e.stopPropagation()}>
        <header className="settings-head">
          <h2>Settings</h2>
          <HoverTooltip content="Close (Esc)">
            <button type="button" className="icon-button" aria-label="Close settings" onClick={close}><X size={14} /></button>
          </HoverTooltip>
        </header>
        <div className="settings-main">
          <nav className="settings-nav" aria-label="Settings sections">
            {sections.map((s) => (
              <button key={s} type="button" aria-current={s === section ? 'true' : undefined} onClick={() => useSettingsUi.getState().setSection(s)}>{s}</button>
            ))}
          </nav>
          <div ref={bodyRef} className="settings-body">
            {[section].map((s) => (
              <section key={s} className="settings-section" aria-label={s} data-section={s}>
                <h3>{s === 'Accounts' ? `Forge accounts · ${profile.name} profile` : s}{s === 'Profile' ? ` (${profile.name})` : s === 'Repository' ? ` (${rt?.repo?.name})` : ''}</h3>
                {s === 'General' && <>
                  <Row id="reposFolder">
                    <TextField id="reposFolder" value={profile.reposFolder ?? ''} placeholder={examplePath('repos')} onCommit={(v) => updateProfile((p) => ({ ...p, reposFolder: v || null }))} />
                    <button type="button" onClick={async () => { const d = await api.pickFolder(profile.reposFolder); if (d) updateProfile((p) => ({ ...p, reposFolder: d })); }}>Choose…</button>
                  </Row>
                  <Row id="dateFormat" group>
                    <Select<DateFormat> id="input-dateFormat" aria-labelledby="label-dateFormat" value={settings.dateFormat} onChange={(v) => setSettings({ dateFormat: v })} options={DATE_CHOICES} />
                  </Row>
                  <Row id="commitLimit">
                    <NumberField id="commitLimit" value={settings.commitLimit} min={1} max={COMMIT_LIMIT_MAX} step={100} onCommit={changeCommitLimit} />
                  </Row>
                  <Row id="density" group>
                    <div role="radiogroup" aria-labelledby="label-density" className="radio-group">
                      {DENSITIES.map((d) => (
                        <HoverTooltip key={d} content={DENSITY_LABELS[d][1]}>
                          <label className="radio"><input type="radio" name="density" checked={density === d} onChange={() => useDensity.getState().setDensity(d)} />{DENSITY_LABELS[d][0]}</label>
                        </HoverTooltip>
                      ))}
                    </div>
                  </Row>
                  <Row id="advanceAfterStage"><input id="input-advanceAfterStage" type="checkbox" checked={advanceAfterStage} onChange={(e) => useFileListPrefs.getState().set({ advanceAfterStage: e.target.checked })} /></Row>
                  <Row id="gravatar"><input id="input-gravatar" type="checkbox" checked={settings.gravatar} onChange={(e) => changeGravatar(e.target.checked)} /></Row>
                  {/* --- 4A T11 --- */}
                  <Row id="forgeAvatars"><input id="input-forgeAvatars" type="checkbox" checked={settings.forgeAvatars} onChange={(e) => changeForgeAvatars(e.target.checked)} /></Row>
                  {/* --- end 4A T11 --- */}
                </>}
                {s === 'Appearance' && <AppearanceSection />}
                {s === 'Fetch' && <>
                  <Row id="fetchInterval" group>
                    <Select<number> id="input-fetchInterval" aria-labelledby="label-fetchInterval" value={fetchSecs} onChange={(v) => setSettings({ fetchIntervalSecs: v })} options={FETCH_CHOICES.some(([v]) => v === fetchSecs) ? FETCH_CHOICES : [...FETCH_CHOICES, [fetchSecs, `Every ${Math.round(fetchSecs / 60)} min`]]} />
                  </Row>
                  <Row id="prune"><input id="input-prune" type="checkbox" checked={settings.prune} onChange={(e) => setSettings({ prune: e.target.checked })} /></Row>
                  <Row id="pushFollowTags"><input id="input-pushFollowTags" type="checkbox" checked={settings.pushFollowTags} onChange={(e) => setSettings({ pushFollowTags: e.target.checked })} /></Row>
                </>}
                {s === 'Editor' && <>
                  <Row id="editor"><EditorPicker id="editor" value={profile.editor} inherit={false} onChange={(v) => updateProfile((p) => ({ ...p, editor: v }))} /></Row>
                  <Row id="stickyScroll"><input id="input-stickyScroll" type="checkbox" checked={stickyScroll} onChange={(e) => useEditorSettings.getState().set({ stickyScroll: e.target.checked })} /></Row>
                  <Row id="editorFontSize"><NumberField id="editorFontSize" value={clampEditorFont(settings.editorFontSize)} min={EDITOR_FONT_MIN} max={EDITOR_FONT_MAX} step={1} onCommit={(n) => setSettings({ editorFontSize: n })} /></Row>
                </>}
                {s === 'Profile' && (
                  <Row id="extraGitconfig">
                    <TextField id="extraGitconfig" value={profile.extraGitconfig ?? ''} placeholder={examplePath('.gitconfig-work')} onCommit={(v) => updateProfile((p) => ({ ...p, extraGitconfig: v || null }))} />
                  </Row>
                )}
                {s === 'Accounts' && <AccountsSection />}
                {s === 'Hosts' && <Row id="hostOverrides" group><HostRows detected={detected} /></Row>}
                {s === 'Advanced' && (
                  <Row id="debugLogging"><input id="input-debugLogging" type="checkbox" checked={settings.debugLogging} onChange={(e) => setSettings({ debugLogging: e.target.checked })} /></Row>
                )}
                {s === 'Repository' && repoPath && repoSettings && (
                  <Row id="repoEditor"><EditorPicker id="repoEditor" value={repoSettings.editor} inherit onChange={(v) => updateRepo(repoPath, (r) => ({ ...r, editor: v }))} /></Row>
                )}
              </section>
            ))}
            {section === 'General' && <p className="dim settings-note">The pinned trunk is set with the pin button in the graph&apos;s header. Zoom is in the status bar.</p>}
            <div className="settings-foot">
              <button type="button" className="danger" onClick={() => void resetAll()}>Reset settings to defaults…</button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
